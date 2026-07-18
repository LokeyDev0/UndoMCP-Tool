#!/usr/bin/env node
import { Command } from 'commander';
import { DatabaseManager } from './journal/database-manager.js';
import { ProxyEngine } from './proxy/engine.js';
import { HttpProxyServer } from './proxy/http-proxy-server.js';
import { HttpRegistry } from './proxy/http-registry.js';
import { handleListHistory } from './tools/undo-tools.js';
import { nanoid } from 'nanoid';
import { generateActionLabel } from './utils/label-generator.js';
import { shouldRecordTool, extractBaseToolName } from './utils/tool-filter.js';

const program = new Command();

program
  .name('undomcp')
  .description('Universal AI Agent Undo Tool via MCP Proxy')
  .version('1.0.0');

// Serve subcommand
program
  .command('serve')
  .description('Start the undomcp JSON-RPC intercepting proxy server')
  .option('--command <cmd>', 'Downstream MCP server executable command')
  .option('--args <args...>', 'Arguments to pass to the downstream MCP server')
  .option('--no-tools', 'Do not inject undo tools into the upstream tool list')
  .option('--session-id <id>', 'Session ID for journaling (generates automatically if omitted)')
  .option('--db <path>', 'Custom SQLite database path')
  .option('--idle-timeout <ms>', 'Idle turn clustering threshold in milliseconds', '180000')
  .action(async (options) => {
    const dbPath = options.db;
    const dbManager = new DatabaseManager(dbPath);
    const sessionId = options.sessionId || `sess_${nanoid()}`;

    // Determine working directory: prefer explicit env var over process.cwd()
    const workingDir = process.env.UNDOMCP_PROJECT_DIR || process.cwd();

    // Initialize session in database
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      workingDirectory: workingDir
    });

    const parsedArgs: string[] = [];
    if (options.args) {
      if (Array.isArray(options.args)) {
        parsedArgs.push(...options.args);
      } else {
        parsedArgs.push(...(options.args as string).split(/\s+/));
      }
    }

    const turnIdleTimeoutMs = Number(options.idleTimeout) || 180000;

    const proxy = new ProxyEngine({
      command: options.command,
      args: parsedArgs,
      dbManager,
      sessionId,
      turnIdleTimeoutMs,
      injectTools: options.tools !== false
    });

    // Handle clean termination to close database and session
    const cleanup = () => {
      try {
        dbManager.endSession(sessionId, new Date().toISOString());
        dbManager.close();
      } catch (err: any) {
        console.error(`[undomcp] Error during session cleanup: ${err.message}`);
      }
    };

    process.on('SIGINT', () => {
      cleanup();
      proxy.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      cleanup();
      proxy.stop();
      process.exit(0);
    });

    proxy.start();

    // Start HTTP proxy server if there are API-key-based HTTP upstreams (URL rewrite approach)
    const httpRegistry = new HttpRegistry();
    const httpUpstreams = httpRegistry.listAll();
    if (Object.keys(httpUpstreams).length > 0) {
      const httpProxy = new HttpProxyServer({
        registry: httpRegistry,
        dbManager,
        sessionId,
        turnIdleTimeoutMs: Number(options.idleTimeout) || 180000,
      });
      httpProxy.start().then((port) => {
        if (port) {
          process.stderr.write(`[undomcp] HTTP proxy listening on 127.0.0.1:${port}\n`);
        }
      }).catch((err) => {
        process.stderr.write(`[undomcp] HTTP proxy failed to start: ${err.message}\n`);
      });

      process.on('SIGINT', () => httpProxy.stop());
      process.on('SIGTERM', () => httpProxy.stop());
    }
  });

// Report-hook subcommand (called by ADE hooks after MCP tool calls)
program
  .command('report-hook')
  .description('Record an MCP tool call in the journal (called by ADE hooks, reads JSON from stdin)')
  .action(async () => {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
    }

    try {
      const data = JSON.parse(input);
      const toolName = data.tool_name || data.name || '';
      const serverName = data.server_name || '';

      // Only record actual MCP tool calls (native tools like Edit/Bash have no mcp__ prefix)
      const isMcpTool = toolName.startsWith('mcp__') || serverName.length > 0;
      if (!isMcpTool) return;

      // Skip undomcp's own tools, native tools, and read-only operations
      if (!shouldRecordTool(toolName, serverName || undefined)) return;
      const baseName = extractBaseToolName(toolName, serverName || undefined);

      const workingDir = process.env.CLAUDE_PROJECT_DIR || process.env.UNDOMCP_PROJECT_DIR || process.cwd();
      const dbManager = new DatabaseManager();
      const sessionId = `hook_${Date.now()}`;

      // Find or create a session for this project
      const sessions = dbManager.getSessionsForProject(workingDir);
      const activeSession = sessions.length > 0 ? sessions[sessions.length - 1].id : sessionId;
      if (sessions.length === 0) {
        dbManager.createSession({ id: sessionId, startedAt: new Date().toISOString(), workingDirectory: workingDir });
      }

      const actionId = `act_${nanoid()}`;
      const namespace = serverName || (toolName.match(/^mcp__([^_]+)__/) || [])[1] || 'http';
      const cleanToolName = baseName;

      dbManager.createAction({
        id: actionId,
        sessionId: activeSession,
        sequenceNum: Date.now(),
        timestamp: new Date().toISOString(),
        actionType: 'mcp_call',
        toolName: cleanToolName,
        namespace,
        parameters: data.tool_input || data.input || data.parameters || {},
        state: 'executed',
        metadata: { label: generateActionLabel(cleanToolName, data.tool_input || data.input || data.parameters || {}) },
      });

      const result = data.tool_result || data.output || data.result || {};
      dbManager.updateActionResults(actionId, true, typeof result === 'object' ? result : { raw: result });
      dbManager.close();
    } catch {
      // Silent failure — don't break the ADE
    }
  });

// Setup subcommand
program
  .command('setup')
  .description('Configure AI agent clients to route tools through undomcp')
  .option('--restore', 'Restore original configuration prior to undomcp setup')
  .option('--binary-path <path>', 'Absolute path to the undomcp binary')
  .option('--all', 'Configure all detected IDEs without interactive selection')
  .action(async (options) => {
    const { runSetup } = await import('./commands/setup.js');
    await runSetup(options);
  });

// Uninstall subcommand
program
  .command('uninstall')
  .description('Remove undomcp from your system (interactive: choose soft or full uninstall)')
  .option('--keep-db', 'Soft uninstall: remove configs and skills but keep the journal database')
  .option('--full', 'Full uninstall: wipe everything including the journal database')
  .action(async (options) => {
    const { runUninstall } = await import('./commands/uninstall.js');
    await runUninstall(options);
  });

// Clear history subcommand
program
  .command('clearHistory')
  .description('Clear the journal database (delete all recorded MCP call history)')
  .action(async () => {
    const { runClearHistory } = await import('./commands/clear-history.js');
    await runClearHistory();
  });

// Handle default command (no arguments)
if (process.argv.length <= 2) {
  const dbManager = new DatabaseManager();
  try {
    const workingDir = process.cwd();
    const history = handleListHistory(dbManager, workingDir, 10);
    if (history.length > 0) {
      console.log(`Project: ${workingDir}`);
      console.log('\nRecent MCP Actions:');
      console.log(JSON.stringify(history, null, 2));
    } else {
      console.log('No MCP actions found for this project.');
    }
  } catch (err: any) {
    console.error(`[undomcp] Error reading journal: ${err.message}`);
  } finally {
    dbManager.close();
  }
} else {
  program.parse(process.argv);
}
