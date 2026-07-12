import { spawn } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { DatabaseManager, Action, Turn } from '../journal/database-manager.js';
import { nanoid } from 'nanoid';
import { UpstreamManager } from './upstream-manager.js';
import {
  UNDO_TOOLS,
  handleListHistory
} from '../tools/undo-tools.js';
import { SchemaCache } from '../undo/schema-cache.js';
import { InverseResolver } from '../undo/inverse-resolver.js';
import { LlmSolver } from '../undo/llm-solver.js';
import { SnapshotStore, computeSha256 } from '../file-safety/snapshot-store.js';
import { UndoController } from '../undo/undo-controller.js';

export interface ProxyEngineOptions {
  command: string;
  args: string[];
  configPath?: string;
  env?: Record<string, string>;
  dbManager?: DatabaseManager;
  sessionId?: string;
  turnId?: string;
  turnIdleTimeoutMs?: number;
  onRequest?: (request: any) => Promise<void> | void;
  onResponse?: (request: any, response: any) => Promise<void> | void;
}

/** Regex patterns for tools that modify local files */
const FILE_TOOL_PATTERNS = [
  /write[_-]?file/i, /create[_-]?file/i, /edit[_-]?file/i,
  /replace[_-]?file/i, /delete[_-]?file/i, /move[_-]?file/i,
  /rename[_-]?file/i, /write[_-]?to[_-]?file/i, /overwrite/i,
  /append[_-]?file/i, /patch/i
];

export class ProxyEngine {
  private command: string;
  private args: string[];
  private env: Record<string, string>;
  private isStopping = false;
  
  private onRequestCallback?: (request: any) => Promise<void> | void;
  private onResponseCallback?: (request: any, response: any) => Promise<void> | void;
  
  private dbManager?: DatabaseManager;
  private sessionId?: string;
  private turnId?: string;
  private nextSequenceNum = 1;
  private turnIdleTimeoutMs = 180000; // default 3 minutes
  private lastActionEndTime?: number;
  private upstreamManager: UpstreamManager;
  
  private activeRequests = new Map<string | number, { request: any; actionId?: string; startTime: number }>();
  private agentReader!: readline.Interface;

  // Phase 3/5/6: Undo system components
  private schemaCache: SchemaCache;
  private inverseResolver: InverseResolver;
  private snapshotStore?: SnapshotStore;
  private undoController?: UndoController;
  private llmSolver?: LlmSolver;

  constructor(options: ProxyEngineOptions) {
    this.command = options.command;
    this.args = options.args;
    this.env = { ...process.env, ...(options.env || {}) } as Record<string, string>;
    this.onRequestCallback = options.onRequest;
    this.onResponseCallback = options.onResponse;
    this.dbManager = options.dbManager;
    this.sessionId = options.sessionId;
    this.turnId = options.turnId;
    if (options.turnIdleTimeoutMs !== undefined) {
      this.turnIdleTimeoutMs = options.turnIdleTimeoutMs;
    }

    if (this.dbManager && this.sessionId) {
      try {
        const actions = this.dbManager.getActionsForSession(this.sessionId);
        if (actions.length > 0) {
          const maxSeq = Math.max(...actions.map(a => a.sequenceNum));
          this.nextSequenceNum = maxSeq + 1;
        }
      } catch (err: any) {
        console.error(`[undomcp] Error initializing sequence number: ${err.message}`);
      }
    }

    this.upstreamManager = new UpstreamManager(options.configPath, {
      command: this.command,
      args: this.args
    });

    // Initialize undo system components
    this.schemaCache = new SchemaCache();
    this.inverseResolver = new InverseResolver(this.schemaCache);
    this.llmSolver = LlmSolver.fromEnv() ?? undefined;

    if (this.dbManager) {
      this.snapshotStore = new SnapshotStore(this.dbManager);
      this.undoController = new UndoController(
        this.dbManager,
        this.snapshotStore,
        this.schemaCache,
        this.inverseResolver,
        this.llmSolver
      );
    }
  }

  /** Exposes the schema cache for testing and external consumers. */
  public getSchemaCache(): SchemaCache {
    return this.schemaCache;
  }

  /**
   * Starts the proxy engine by spawning the upstream processes and connecting streams.
   */
  public start(
    agentStdin: Readable = process.stdin,
    agentStdout: Writable = process.stdout,
    agentStderr: Writable = process.stderr
  ): void {
    this.isStopping = false;

    // Start all configured upstreams
    this.upstreamManager.start(agentStderr);

    // Forward upstream messages (not parsed by pending promises) to the agent
    this.upstreamManager.onMessage = (ns, msg) => {
      this.forwardToAgent(JSON.stringify(msg), agentStdout);
    };

    // Create line-by-line reader for agent input
    this.agentReader = readline.createInterface({
      input: agentStdin,
      output: undefined,
      historySize: 0,
    });

    // Process agent requests -> upstream
    this.agentReader.on('line', (line) => {
      this.handleAgentLine(line, agentStdout);
    });

    // Setup signal forwarding
    this.setupSignalHandlers();
  }

  /**
   * Stops the proxy engine and terminates the child processes.
   */
  public stop(): void {
    this.isStopping = true;
    this.cleanup();
    this.upstreamManager.stop();
  }

  private cleanup(): void {
    try {
      this.agentReader.close();
    } catch {
      // Ignore cleanup failures
    }
  }

  private setupSignalHandlers(): void {
    const forwardSignal = () => {
      this.upstreamManager.stop();
    };

    process.on('SIGINT', () => forwardSignal());
    process.on('SIGTERM', () => forwardSignal());
  }

  private async handleMarkTurn(request: any, agentStdout: Writable): Promise<void> {
    if (this.dbManager && this.sessionId) {
      try {
        const promptText = request.params?.arguments?.prompt_text || '';
        const lastTurn = this.dbManager.getLastTurnForSession(this.sessionId);
        const nextTurnNum = lastTurn ? lastTurn.turnNum + 1 : 1;
        const turnId = `turn_${nanoid()}`;
        this.dbManager.createTurn({
          id: turnId,
          sessionId: this.sessionId,
          turnNum: nextTurnNum,
          promptText,
          timestamp: new Date().toISOString(),
          actionCount: 0
        });
        this.turnId = turnId;
        this.lastActionEndTime = Date.now();
      } catch (err: any) {
        console.error(`[undomcp] Database error in undomcp_mark_turn: ${err.message}`);
      }
    }
    const response = {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [
          {
            type: 'text',
            text: 'Turn marked successfully.'
          }
        ]
      }
    };
    this.forwardToAgent(JSON.stringify(response), agentStdout);
  }

  private async handleAgentLine(line: string, agentStdout: Writable): Promise<void> {
    if (!line.trim()) return;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      // If not valid JSON, forward it to default upstream
      const defNs = this.upstreamManager.getNamespaces()[0] || 'default';
      this.upstreamManager.getUpstreamInstance(defNs)?.process.stdin?.write(line + '\n');
      return;
    }

    const isRequest = parsed && parsed.id !== undefined && parsed.method !== undefined;
    
    if (isRequest) {
      if (parsed.method === 'tools/list') {
        if (this.onRequestCallback) {
          try {
            await this.onRequestCallback(parsed);
          } catch (err: any) {
            console.error(`[undomcp] Error in onRequest callback: ${err.message}`);
          }
        }
        try {
          // Retry up to 3 times with 2s delay if upstream isn't ready yet
          let allTools: any[] = [];
          let attempts = 0;
          while (attempts < 3) {
            try {
              allTools = await this.upstreamManager.listAllTools();
              break;
            } catch (err: any) {
              attempts++;
              if (attempts >= 3) throw err;
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }

          // Phase 3: Cache tool schemas for InverseResolver
          this.schemaCache.updateFromToolsList({ tools: allTools });

          const aggregatedTools = [...allTools, ...UNDO_TOOLS];
          const response = {
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              tools: aggregatedTools
            }
          };
          if (this.onResponseCallback) {
            try {
              await this.onResponseCallback(parsed, response);
            } catch (err: any) {
              console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
            }
          }
          this.forwardToAgent(JSON.stringify(response), agentStdout);
        } catch (err: any) {
          const response = {
            jsonrpc: '2.0',
            id: parsed.id,
            error: {
              code: -32603,
              message: `Failed listing upstream tools: ${err.message}`
            }
          };
          if (this.onResponseCallback) {
            try {
              await this.onResponseCallback(parsed, response);
            } catch (err: any) {
              console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
            }
          }
          this.forwardToAgent(JSON.stringify(response), agentStdout);
        }
        return;
      }

      if (parsed.method === 'tools/call') {
        const toolName = parsed.params?.name || '';
        if (toolName.startsWith('undomcp_')) {
          await this.handleUndoToolCall(parsed, agentStdout);
          return;
        }

        // Journaling tool call — log all MCP calls for full audit trail
        let actionId: string | undefined;
        const startTime = Date.now();

        const parts = toolName.split('__');
        const namespace = parts.length > 1 ? parts[0] : undefined;
        const baseToolName = parts.length > 1 ? parts[1] : toolName;

        if (this.dbManager && this.sessionId) {
          try {
            // Turn clustering
            this.ensureActiveTurnId();

            actionId = `act_${nanoid()}`;

            const args = parsed.params?.arguments || {};
            let label = `Call ${toolName}`;
            if (baseToolName === 'write_file' || baseToolName === 'edit_file' || baseToolName === 'replace_file_content' || baseToolName === 'write_to_file') {
              const filePath = args.path || args.TargetFile || args.filePath || '';
              label = `Modify file: ${filePath}`;
            } else if (baseToolName === 'run_command' || baseToolName === 'execute_command') {
              const command = args.command || args.CommandLine || '';
              label = `Execute command: ${command}`;
            } else if (args.path || args.file || args.filename) {
              const pathVal = args.path || args.file || args.filename;
              label = `${baseToolName} on ${pathVal}`;
            } else if (args.id || args.name) {
              const idVal = args.id || args.name;
              label = `${baseToolName} (${idVal})`;
            }

            const action: Action = {
              id: actionId,
              sessionId: this.sessionId,
              turnId: this.turnId,
              sequenceNum: this.nextSequenceNum++,
              timestamp: new Date(startTime).toISOString(),
              actionType: 'mcp_call',
              toolName: baseToolName,
              namespace,
              parameters: args,
              state: 'executed',
              metadata: { label }
            };

            this.dbManager.createAction(action);
          } catch (err: any) {
            console.error(`[undomcp] Database error in pre-action logging: ${err.message}`);
          }
        }

        // Phase 6: Capture pre-snapshot for file-modifying tools
        const args = parsed.params?.arguments || {};
        const isFileModifying = FILE_TOOL_PATTERNS.some(p => p.test(baseToolName));
        const filePath = args.path || args.filePath || args.file || args.TargetFile || args.filename;
        let preHash: string | undefined;

        if (isFileModifying && filePath && this.snapshotStore && actionId) {
          try {
            const absolutePath = path.resolve(filePath);
            if (fs.existsSync(absolutePath)) {
              const content = fs.readFileSync(absolutePath);
              const preSnapshotId = this.snapshotStore.createSnapshot(
                actionId, absolutePath, content, 'pre'
              );
              preHash = computeSha256(content);
              if (this.dbManager && preSnapshotId !== 'snap_skipped_too_large') {
                this.dbManager.updateActionTransition(actionId, preSnapshotId, undefined, preHash);
              }
            }
          } catch (err: any) {
            // Non-fatal: snapshot capture failure shouldn't block the actual tool call
            console.error(`[undomcp] Snapshot capture failed: ${err.message}`);
          }
        }

        if (this.onRequestCallback) {
          try {
            await this.onRequestCallback(parsed);
          } catch (err: any) {
            console.error(`[undomcp] Error in onRequest callback: ${err.message}`);
          }
        }

        // Forward call upstream and wait for response
        try {
          const response = await this.upstreamManager.routeCall(toolName, parsed.params.arguments, parsed.id);
          this.lastActionEndTime = Date.now();

          // Journal response
          if (this.dbManager && actionId) {
            try {
              const latencyMs = Date.now() - startTime;
              const hasRpcError = response.error !== undefined;
              const hasMcpError = response.result && response.result.isError === true;
              const success = !hasRpcError && !hasMcpError;
              const resultData = response.result || response.error || {};

              this.dbManager.updateActionResults(actionId, success, resultData, latencyMs);
            } catch (err: any) {
              console.error(`[undomcp] Database error in post-action logging: ${err.message}`);
            }
          }

          // Phase 6: Capture post-snapshot for file-modifying tools
          if (isFileModifying && filePath && this.snapshotStore && actionId) {
            try {
              const absolutePath = path.resolve(filePath);
              if (fs.existsSync(absolutePath)) {
                const content = fs.readFileSync(absolutePath);
                const postSnapshotId = this.snapshotStore.createSnapshot(
                  actionId, absolutePath, content, 'post'
                );
                const postHash = computeSha256(content);
                if (this.dbManager && postSnapshotId !== 'snap_skipped_too_large') {
                  this.dbManager.updateActionTransition(actionId, undefined, postSnapshotId, undefined, postHash);
                }
              }
            } catch (err: any) {
              console.error(`[undomcp] Post-snapshot capture failed: ${err.message}`);
            }
          }

          if (this.onResponseCallback) {
            try {
              await this.onResponseCallback(parsed, response);
            } catch (err: any) {
              console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
            }
          }

          // Send response back to agent
          this.forwardToAgent(JSON.stringify(response), agentStdout);
        } catch (err: any) {
          const response = {
            jsonrpc: '2.0',
            id: parsed.id,
            error: {
              code: -32603,
              message: `Call execution failed upstream: ${err.message}`
            }
          };
          this.forwardToAgent(JSON.stringify(response), agentStdout);
        }
        return;
      }

      // Lifecycle call (e.g. initialize)
      if (this.onRequestCallback) {
        try {
          await this.onRequestCallback(parsed);
        } catch (err: any) {
          console.error(`[undomcp] Error in onRequest callback: ${err.message}`);
        }
      }

      // For 'initialize': respond immediately so the IDE doesn't timeout,
      // then initialize upstreams in the background.
      if (parsed.method === 'initialize') {
        // Send our own initialize response right away
        const immediateResponse = {
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            protocolVersion: parsed.params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: {
              name: 'undomcp-proxy',
              version: '1.0.0'
            }
          }
        };
        this.forwardToAgent(JSON.stringify(immediateResponse), agentStdout);

        // Initialize upstreams in background (non-blocking)
        this.upstreamManager.broadcast('initialize', parsed.params, `bg_init_${nanoid()}`)
          .then(() => {
            // Upstreams ready — tools/list will work when called later
          })
          .catch((err: any) => {
            console.error(`[undomcp] Background upstream initialization failed: ${err.message}`);
          });
        return;
      }

      try {
        const response = await this.upstreamManager.broadcast(parsed.method, parsed.params, parsed.id);
        if (this.onResponseCallback) {
          try {
            await this.onResponseCallback(parsed, response);
          } catch (err: any) {
            console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
          }
        }
        this.forwardToAgent(JSON.stringify(response), agentStdout);
      } catch (err: any) {
        const response = {
          jsonrpc: '2.0',
          id: parsed.id,
          error: {
            code: -32603,
            message: `Broadcast request failed: ${err.message}`
          }
        };
        if (this.onResponseCallback) {
          try {
            await this.onResponseCallback(parsed, response);
          } catch (err: any) {
            console.error(`[undomcp] Error in onResponse callback: ${err.message}`);
          }
        }
        this.forwardToAgent(JSON.stringify(response), agentStdout);
      }
    } else {
      // Notification
      for (const ns of this.upstreamManager.getNamespaces()) {
        this.upstreamManager.callUpstreamDirect(ns, parsed.method, parsed.params, undefined).catch(() => {});
      }
    }
  }

  private async handleUndoToolCall(request: any, agentStdout: Writable): Promise<void> {
    const toolName = request.params?.name;
    const args = request.params?.arguments || {};
    let result: any;
    let error: any;

    if (toolName === 'undomcp_mark_turn') {
      await this.handleMarkTurn(request, agentStdout);
      return;
    }

    if (!this.dbManager || !this.sessionId) {
      error = {
        code: -32603,
        message: 'DatabaseManager or Session ID is not configured on the proxy.'
      };
    } else {
      try {
        if (toolName === 'undomcp_list_history') {
          const limit = args.limit !== undefined ? Number(args.limit) : 10;
          // Get working directory from the current session for project-scoped query
          const session = this.dbManager.getSession(this.sessionId);
          const workingDir = session?.workingDirectory || process.cwd();
          const list = handleListHistory(this.dbManager, workingDir, limit);
          result = { content: [{ type: 'text', text: JSON.stringify(list, null, 2) }] };

        } else if (toolName === 'undomcp_undo_action') {
          // Phase 5: Execute undo for specified action IDs
          result = await this.handleUndoAction(args);

        } else {
          error = {
            code: -32601,
            message: `Method not found: ${toolName}`
          };
        }
      } catch (err: any) {
        error = {
          code: -32603,
          message: err.message
        };
      }
    }

    const response = {
      jsonrpc: '2.0',
      id: request.id,
      ...(error ? { error } : { result })
    };
    this.forwardToAgent(JSON.stringify(response), agentStdout);
  }

  /**
   * Phase 5: Handles the undomcp_undo_action tool call.
   * Uses UndoController for resolution, then dispatches MCP payloads via upstream.
   */
  private async handleUndoAction(args: Record<string, any>): Promise<any> {
    const actionIds: string[] = args.action_ids || [];
    if (actionIds.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'No action_ids provided' }) }]
      };
    }

    if (!this.dbManager) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Undo system not initialized' }) }]
      };
    }

    const finalResults: any[] = [];

    for (const actionId of actionIds) {
      const action = this.dbManager.getAction(actionId);
      if (!action) {
        finalResults.push({
          actionId,
          success: false,
          outcome: 'error',
          error: `Action ${actionId} not found in journal.`,
        });
        continue;
      }

      if (action.state === 'undone') {
        finalResults.push({
          actionId,
          success: true,
          outcome: 'already_undone',
        });
        continue;
      }

      // File-change actions: delegate to UndoController for snapshot restoration
      if (action.actionType === 'file_change' && this.undoController) {
        try {
          const controllerResults = await this.undoController.execute([actionId]);
          for (const cr of controllerResults) {
            if (cr.outcome === 'file_restored') {
              finalResults.push({
                actionId: cr.actionId,
                success: true,
                outcome: 'file_restored',
              });
            } else if (cr.outcome === 'skipped') {
              finalResults.push({
                actionId: cr.actionId,
                success: true,
                outcome: 'already_undone',
              });
            } else {
              finalResults.push({
                actionId: cr.actionId,
                success: false,
                outcome: 'error',
                error: cr.error || 'File restore failed',
              });
            }
          }
        } catch (err: any) {
          finalResults.push({
            actionId,
            success: false,
            outcome: 'error',
            error: err.message,
          });
        }
        continue;
      }

      // MCP actions: just mark as undone (AI agent handles the actual inverse call)
      try {
        this.dbManager.updateActionState(
          actionId,
          'undone',
          new Date().toISOString()
        );
        finalResults.push({
          actionId,
          success: true,
          outcome: 'marked_undone',
        });
      } catch (err: any) {
        finalResults.push({
          actionId,
          success: false,
          outcome: 'error',
          error: err.message,
        });
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(finalResults, null, 2) }]
    };
  }

  private forwardToAgent(line: string, agentStdout: Writable): void {
    if (!agentStdout.destroyed) {
      agentStdout.write(line + '\n');
    }
  }

  private ensureActiveTurnId(): string {
    if (!this.dbManager || !this.sessionId) {
      throw new Error('DatabaseManager and SessionId must be initialized');
    }
    
    if (this.lastActionEndTime === undefined) {
      const lastActionTimeStr = this.dbManager.getLastActionTimestampForSession(this.sessionId);
      if (lastActionTimeStr) {
        this.lastActionEndTime = Date.parse(lastActionTimeStr);
      }
    }

    const lastTurn = this.dbManager.getLastTurnForSession(this.sessionId);
    
    if (!this.turnId) {
      if (lastTurn) {
        if (this.lastActionEndTime !== undefined && (Date.now() - this.lastActionEndTime > this.turnIdleTimeoutMs)) {
          const nextTurnNum = lastTurn.turnNum + 1;
          this.turnId = `turn_${nanoid()}`;
          this.dbManager.createTurn({
            id: this.turnId,
            sessionId: this.sessionId,
            turnNum: nextTurnNum,
            timestamp: new Date().toISOString(),
            actionCount: 0
          });
        } else {
          this.turnId = lastTurn.id;
        }
      } else {
        this.turnId = `turn_${nanoid()}`;
        this.dbManager.createTurn({
          id: this.turnId,
          sessionId: this.sessionId,
          turnNum: 1,
          timestamp: new Date().toISOString(),
          actionCount: 0
        });
      }
    } else {
      if (lastTurn && this.lastActionEndTime !== undefined && (Date.now() - this.lastActionEndTime > this.turnIdleTimeoutMs)) {
        const nextTurnNum = lastTurn.turnNum + 1;
        this.turnId = `turn_${nanoid()}`;
        this.dbManager.createTurn({
          id: this.turnId,
          sessionId: this.sessionId,
          turnNum: nextTurnNum,
          timestamp: new Date().toISOString(),
          actionCount: 0
        });
      }
    }

    return this.turnId;
  }
}
