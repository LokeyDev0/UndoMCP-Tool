import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { nanoid } from 'nanoid';
import { HttpRegistry, HttpUpstreamEntry } from './http-registry.js';
import { HttpUpstreamClient } from './http-upstream-client.js';
import { DatabaseManager, Action } from '../journal/database-manager.js';
import { generateActionLabel } from '../utils/label-generator.js';

const FILE_TOOL_PATTERNS = [
  /write[_-]?file/i, /create[_-]?file/i, /edit[_-]?file/i,
  /replace[_-]?file/i, /delete[_-]?file/i, /remove[_-]?file/i,
  /move[_-]?file/i, /rename[_-]?file/i, /copy[_-]?file/i,
  /write[_-]?to[_-]?file/i, /overwrite/i, /append[_-]?file/i,
  /^patch$/i, /^patch[_-]?file$/i, /create[_-]?directory/i, /mkdir/i
];

export interface HttpProxyServerOptions {
  registry: HttpRegistry;
  dbManager: DatabaseManager;
  sessionId: string;
  turnIdleTimeoutMs?: number;
  lockFilePath?: string;
}

export class HttpProxyServer {
  private server: http.Server | null = null;
  private registry: HttpRegistry;
  private dbManager: DatabaseManager;
  private sessionId: string;
  private clients = new Map<string, HttpUpstreamClient>();
  private turnId?: string;
  private nextSequenceNum = 1;
  private lastActionEndTime?: number;
  private turnIdleTimeoutMs: number;
  private lockFilePath: string;
  private boundPort: number | null = null;

  constructor(options: HttpProxyServerOptions) {
    this.registry = options.registry;
    this.dbManager = options.dbManager;
    this.sessionId = options.sessionId;
    this.turnIdleTimeoutMs = options.turnIdleTimeoutMs || 180000;
    this.lockFilePath = options.lockFilePath || path.join(os.homedir(), '.undomcp', 'http-proxy.lock');
  }

  public async start(): Promise<number | null> {
    if (this.isAlreadyRunning()) {
      return null;
    }

    const port = await this.findAvailablePort(this.registry.getPort());
    if (port !== this.registry.getPort()) {
      this.registry.setPort(port);
    }

    this.initializeClients();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
        }
      });
    });

    this.server.on('upgrade', (req, socket, head) => {
      this.handleWebSocketUpgrade(req, socket as net.Socket, head);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(port, '127.0.0.1', () => {
        this.boundPort = port;
        this.writeLockFile(port);
        resolve(port);
      });

      this.server!.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          resolve(null);
        } else {
          reject(err);
        }
      });
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
    this.removeLockFile();
  }

  public getPort(): number | null {
    return this.boundPort;
  }

  private initializeClients(): void {
    const upstreams = this.registry.listAll();
    for (const [namespace, entry] of Object.entries(upstreams)) {
      this.clients.set(namespace, new HttpUpstreamClient({
        url: entry.url,
        transport: entry.transport === 'streamable-http' ? 'http' : entry.transport,
      }));
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const { namespace, remainingPath } = this.parseRoute(req.url || '');

      if (!namespace) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid proxy path. Expected /proxy/{namespace}/...' }));
        return;
      }

      const entry = this.registry.lookup(namespace);
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Unknown namespace: ${namespace}` }));
        return;
      }

      let client = this.clients.get(namespace);
      if (!client) {
        client = new HttpUpstreamClient({
          url: entry.url,
          transport: entry.transport === 'streamable-http' ? 'http' : entry.transport,
        });
        this.clients.set(namespace, client);
      }

      const method = req.method || 'GET';
      const accept = req.headers['accept'] || '';

      if (method === 'GET' && accept.includes('text/event-stream')) {
        await this.handleSSE(req, res, client, namespace, entry);
      } else if (method === 'POST') {
        await this.handlePost(req, res, client, namespace, entry);
      } else if (method === 'GET' || method === 'DELETE') {
        await this.handleSimpleForward(req, res, client, namespace, method);
      } else {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Method ${method} not supported` }));
      }
    } catch (err: any) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
      }
    }
  }

  private async handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    client: HttpUpstreamClient,
    namespace: string,
    entry: HttpUpstreamEntry
  ): Promise<void> {
    const body = await this.readBody(req);
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      // Not JSON — forward as-is without journaling
      const result = await client.forwardRequest(body, this.extractHeaders(req), 'POST');
      res.writeHead(result.status, result.headers);
      res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      return;
    }

    const isToolCall = parsed.method === 'tools/call';
    const toolName = parsed.params?.name || '';
    const args = parsed.params?.arguments || {};
    const isUndoAction = args.__is_undo === true;

    if (isUndoAction) {
      delete parsed.params.arguments.__is_undo;
    }

    let actionId: string | undefined;
    const startTime = Date.now();

    if (isToolCall && !isUndoAction) {
      actionId = this.journalPreAction(toolName, namespace, args, entry, startTime);
    }

    const result = await client.forwardRequest(parsed, this.extractHeaders(req), 'POST');

    if (result.isStream && result.rawResponse) {
      // SSE streaming response — pipe through while capturing the result
      res.writeHead(result.status, result.headers);
      let sseBuffer = '';
      result.rawResponse.on('data', (chunk: Buffer) => {
        const str = chunk.toString();
        sseBuffer += str;
        res.write(str);
      });
      result.rawResponse.on('end', () => {
        if (actionId) {
          const jsonRpcResult = this.extractJsonRpcFromSSE(sseBuffer);
          this.journalPostAction(actionId, jsonRpcResult, startTime);
        }
        res.end();
      });
      result.rawResponse.on('error', () => res.end());
    } else {
      if (actionId) {
        this.journalPostAction(actionId, result.body, startTime);
      }
      res.writeHead(result.status, result.headers);
      res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
    }
  }

  private async handleSSE(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    client: HttpUpstreamClient,
    namespace: string,
    entry: HttpUpstreamEntry
  ): Promise<void> {
    const upstream = await client.forwardSSEConnect(this.extractHeaders(req));

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });

    upstream.on('data', (chunk: Buffer) => {
      const str = chunk.toString();
      // Journal any tool call results that come through the SSE stream
      this.journalSSEEvent(str, namespace, entry);
      res.write(str);
    });

    upstream.on('end', () => res.end());
    upstream.on('error', () => res.end());
    req.on('close', () => upstream.destroy());
  }

  private handleWebSocketUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer
  ): void {
    const { namespace } = this.parseRoute(req.url || '');
    if (!namespace) {
      socket.destroy();
      return;
    }

    const entry = this.registry.lookup(namespace);
    if (!entry) {
      socket.destroy();
      return;
    }

    // For WebSocket, we'd need a WS library for full proxy support.
    // For now, respond with 501 Not Implemented for WS upgrades.
    // This can be added in a follow-up when WS MCP servers become common.
    socket.write('HTTP/1.1 501 Not Implemented\r\n\r\n');
    socket.destroy();
  }

  private async handleSimpleForward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    client: HttpUpstreamClient,
    namespace: string,
    method: string
  ): Promise<void> {
    const result = await client.forwardRequest('', this.extractHeaders(req), method);
    res.writeHead(result.status, result.headers);
    res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
  }

  private journalPreAction(
    toolName: string,
    namespace: string,
    args: Record<string, any>,
    entry: HttpUpstreamEntry,
    startTime: number
  ): string | undefined {
    try {
      this.ensureActiveTurnId();

      const actionId = `act_${nanoid()}`;
      const isFileModifying = FILE_TOOL_PATTERNS.some(p => p.test(toolName));
      const filePath = args.path || args.filePath || args.file || args.filename || args.uri;
      const actionType = (isFileModifying && filePath) ? 'file_change' : 'mcp_call';

      const label = generateActionLabel(toolName, args);

      const action: Action = {
        id: actionId,
        sessionId: this.sessionId,
        turnId: this.turnId,
        sequenceNum: this.nextSequenceNum++,
        timestamp: new Date(startTime).toISOString(),
        actionType,
        toolName,
        namespace,
        parameters: args,
        state: 'executed',
        metadata: { label, projectDir: entry.projectDir },
      };

      this.dbManager.createAction(action);
      return actionId;
    } catch (err: any) {
      console.error(`[undomcp-http] Journal pre-action error: ${err.message}`);
      return undefined;
    }
  }

  private journalPostAction(actionId: string, result: any, startTime: number): void {
    try {
      const latency = Date.now() - startTime;
      const isError = result && (result.error !== undefined);
      const resultData = isError ? result.error : (result?.result || result);
      const success = !isError;
      const data = typeof resultData === 'object' ? resultData : { raw: resultData };

      this.dbManager.updateActionResults(actionId, success, data, latency);

      this.lastActionEndTime = Date.now();
    } catch (err: any) {
      console.error(`[undomcp-http] Journal post-action error: ${err.message}`);
    }
  }

  private ensureActiveTurnId(): void {
    const now = Date.now();
    if (!this.turnId || (this.lastActionEndTime && (now - this.lastActionEndTime) > this.turnIdleTimeoutMs)) {
      const lastTurn = this.dbManager.getLastTurnForSession(this.sessionId);
      const nextTurnNum = lastTurn ? lastTurn.turnNum + 1 : 1;
      this.turnId = `turn_${nanoid()}`;
      this.dbManager.createTurn({
        id: this.turnId,
        sessionId: this.sessionId,
        turnNum: nextTurnNum,
        timestamp: new Date(now).toISOString(),
        actionCount: 0,
      });
    }
  }

  private journalSSEEvent(data: string, namespace: string, entry: HttpUpstreamEntry): void {
    // SSE events are formatted as "data: {...}\n\n"
    // We look for JSON-RPC tool call results in the stream
    // This is a best-effort capture for SSE transport
    const lines = data.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const json = JSON.parse(line.slice(6));
          if (json.method === 'tools/call' && json.params) {
            const toolName = json.params.name || '';
            const args = json.params.arguments || {};
            if (!args.__is_undo) {
              this.journalPreAction(toolName, namespace, args, entry, Date.now());
            }
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    }
  }

  private extractJsonRpcFromSSE(buffer: string): any {
    // Parse the last JSON-RPC response from an SSE stream
    const lines = buffer.split('\n');
    let lastJson: any = null;
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          lastJson = JSON.parse(line.slice(6));
        } catch {
          // Skip non-JSON lines
        }
      }
    }
    return lastJson;
  }

  private parseRoute(url: string): { namespace: string | null; remainingPath: string } {
    // Expected: /proxy/{namespace}/... or /proxy/{namespace}
    const match = url.match(/^\/proxy\/([^/]+)(\/.*)?$/);
    if (!match) {
      return { namespace: null, remainingPath: '' };
    }
    return { namespace: match[1], remainingPath: match[2] || '/' };
  }

  private extractHeaders(req: http.IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value && key !== 'host' && key !== 'connection') {
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }
    }
    return headers;
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private async findAvailablePort(preferred: number): Promise<number> {
    for (let port = preferred; port < preferred + 10; port++) {
      const available = await this.isPortAvailable(port);
      if (available) return port;
    }
    // Fallback: let OS assign
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address() as net.AddressInfo;
        srv.close(() => resolve(addr.port));
      });
      srv.on('error', reject);
    });
  }

  private isPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => {
        srv.close(() => resolve(true));
      });
      srv.listen(port, '127.0.0.1');
    });
  }

  private isAlreadyRunning(): boolean {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        const content = fs.readFileSync(this.lockFilePath, 'utf8');
        const { pid } = JSON.parse(content);
        // Check if process is still alive
        try {
          process.kill(pid, 0);
          return true; // Process exists
        } catch {
          // Process is dead, stale lock file
          this.removeLockFile();
          return false;
        }
      }
    } catch {
      // Error reading lock file, assume not running
    }
    return false;
  }

  private writeLockFile(port: number): void {
    try {
      const dir = path.dirname(this.lockFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.lockFilePath, JSON.stringify({ pid: process.pid, port }), 'utf8');
    } catch {
      // Non-fatal
    }
  }

  private removeLockFile(): void {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        fs.unlinkSync(this.lockFilePath);
      }
    } catch {
      // Non-fatal
    }
  }
}
