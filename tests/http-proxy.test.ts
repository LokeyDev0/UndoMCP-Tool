import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { HttpProxyServer } from '../src/proxy/http-proxy-server.js';
import { HttpRegistry } from '../src/proxy/http-registry.js';
import { DatabaseManager } from '../src/journal/database-manager.js';
import { nanoid } from 'nanoid';

function createTempDir(): string {
  const dir = path.join(os.tmpdir(), `undomcp-http-test-${nanoid(8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sendRequest(port: number, path: string, body: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: any = raw;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode || 500, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('HttpProxyServer', () => {
  let tempDir: string;
  let dbManager: DatabaseManager;
  let registry: HttpRegistry;
  let proxyServer: HttpProxyServer;
  let mockServer: http.Server;
  let mockPort: number;
  let proxyPort: number;

  beforeEach(async () => {
    tempDir = createTempDir();
    const dbPath = path.join(tempDir, 'journal.db');
    const registryPath = path.join(tempDir, 'http-registry.json');

    dbManager = new DatabaseManager(dbPath);
    registry = new HttpRegistry(registryPath);

    // Start a mock MCP server that echoes back tool calls
    mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const response: any = { jsonrpc: '2.0', id: body.id };

        if (body.method === 'tools/list') {
          response.result = {
            tools: [
              { name: 'create_page', description: 'Create a page', inputSchema: { type: 'object' } },
              { name: 'delete_page', description: 'Delete a page', inputSchema: { type: 'object' } },
            ]
          };
        } else if (body.method === 'tools/call') {
          response.result = {
            content: [{ type: 'text', text: JSON.stringify({ id: 'page_123', title: 'Test' }) }]
          };
        } else if (body.method === 'initialize') {
          response.result = {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-mcp', version: '1.0.0' }
          };
        } else {
          response.result = {};
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address() as { port: number };
        mockPort = addr.port;
        resolve();
      });
    });

    // Register the mock server in the HTTP registry
    registry.register('mock', {
      url: `http://127.0.0.1:${mockPort}/`,
      transport: 'http',
      projectDir: tempDir,
    });

    const sessionId = `sess_${nanoid()}`;
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      workingDirectory: tempDir,
    });

    // Use a unique port range per test to avoid conflicts
    const basePort = 19800 + Math.floor(Math.random() * 100);
    registry.setPort(basePort);

    proxyServer = new HttpProxyServer({
      registry,
      dbManager,
      sessionId,
      lockFilePath: path.join(tempDir, 'http-proxy.lock'),
    });

    const port = await proxyServer.start();
    expect(port).not.toBeNull();
    proxyPort = port!;
  });

  afterEach(() => {
    proxyServer.stop();
    mockServer.close();
    dbManager.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should forward tools/list and return results', async () => {
    const result = await sendRequest(proxyPort, '/proxy/mock/', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    expect(result.status).toBe(200);
    expect(result.body.result.tools).toHaveLength(2);
    expect(result.body.result.tools[0].name).toBe('create_page');
  });

  it('should forward tools/call and journal the action', async () => {
    const result = await sendRequest(proxyPort, '/proxy/mock/', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_page',
        arguments: { title: 'My Test Page', parent_id: 'workspace_abc' },
      },
    });

    expect(result.status).toBe(200);
    expect(result.body.result.content[0].text).toContain('page_123');

    // Verify it was journaled
    const actions = dbManager.getRecentActionsForProject(tempDir, 10);
    expect(actions.length).toBe(1);
    expect(actions[0].toolName).toBe('create_page');
    expect(actions[0].namespace).toBe('mock');
    expect(actions[0].parameters).toEqual({ title: 'My Test Page', parent_id: 'workspace_abc' });
    expect(actions[0].resultSuccess).toBe(1);
  });

  it('should not journal tools/call with __is_undo flag', async () => {
    const result = await sendRequest(proxyPort, '/proxy/mock/', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'delete_page',
        arguments: { page_id: 'page_123', __is_undo: true },
      },
    });

    expect(result.status).toBe(200);

    // Should NOT be journaled
    const actions = dbManager.getRecentActionsForProject(tempDir, 10);
    expect(actions.length).toBe(0);
  });

  it('should not journal non-tool-call methods', async () => {
    await sendRequest(proxyPort, '/proxy/mock/', {
      jsonrpc: '2.0',
      id: 4,
      method: 'initialize',
      params: {},
    });

    const actions = dbManager.getRecentActionsForProject(tempDir, 10);
    expect(actions.length).toBe(0);
  });

  it('should pass through authorization headers to upstream', async () => {
    // Modify mock server to check for auth header
    mockServer.close();
    let receivedAuth: string | undefined;

    mockServer = http.createServer((req, res) => {
      receivedAuth = req.headers['authorization'] as string;
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }));
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(mockPort, '127.0.0.1', () => resolve());
    });

    await sendRequest(proxyPort, '/proxy/mock/', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/list',
      params: {},
    }, { 'authorization': 'Bearer ntn_secret_token_123' });

    expect(receivedAuth).toBe('Bearer ntn_secret_token_123');
  });

  it('should return 404 for unknown namespace', async () => {
    const result = await sendRequest(proxyPort, '/proxy/unknown/', {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/list',
      params: {},
    });

    expect(result.status).toBe(404);
    expect(result.body.error).toContain('Unknown namespace');
  });

  it('should return 404 for invalid path', async () => {
    const result = await sendRequest(proxyPort, '/invalid/path', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
      params: {},
    });

    expect(result.status).toBe(404);
    expect(result.body.error).toContain('Invalid proxy path');
  });
});

describe('HttpRegistry', () => {
  let tempDir: string;
  let registry: HttpRegistry;

  beforeEach(() => {
    tempDir = createTempDir();
    registry = new HttpRegistry(path.join(tempDir, 'registry.json'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should register and lookup upstreams', () => {
    registry.register('notion', {
      url: 'https://mcp.notion.com/mcp',
      transport: 'http',
      projectDir: '/projects/myapp',
    });

    const entry = registry.lookup('notion');
    expect(entry).toBeDefined();
    expect(entry!.url).toBe('https://mcp.notion.com/mcp');
    expect(entry!.transport).toBe('http');
    expect(entry!.projectDir).toBe('/projects/myapp');
  });

  it('should unregister upstreams', () => {
    registry.register('notion', {
      url: 'https://mcp.notion.com/mcp',
      transport: 'http',
    });
    registry.unregister('notion');
    expect(registry.lookup('notion')).toBeUndefined();
  });

  it('should persist across instances', () => {
    const registryPath = path.join(tempDir, 'registry.json');
    const reg1 = new HttpRegistry(registryPath);
    reg1.register('github', {
      url: 'https://api.github.com/mcp',
      transport: 'sse',
    });

    const reg2 = new HttpRegistry(registryPath);
    const entry = reg2.lookup('github');
    expect(entry).toBeDefined();
    expect(entry!.url).toBe('https://api.github.com/mcp');
    expect(entry!.transport).toBe('sse');
  });

  it('should build local proxy URL', () => {
    registry.setPort(19750);
    const url = registry.buildLocalUrl('notion');
    expect(url).toBe('http://127.0.0.1:19750/proxy/notion/');
  });

  it('should list all upstreams', () => {
    registry.register('a', { url: 'http://a.com', transport: 'http' });
    registry.register('b', { url: 'http://b.com', transport: 'sse' });
    const all = registry.listAll();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all.a.url).toBe('http://a.com');
    expect(all.b.url).toBe('http://b.com');
  });
});
