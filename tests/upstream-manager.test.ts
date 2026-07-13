import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PassThrough } from 'stream';
import { UpstreamManager } from '../src/proxy/upstream-manager.js';

describe('UpstreamManager', () => {
  const tempDir = os.tmpdir();
  const mockServerPath = path.join(tempDir, `mock-server-up-${Date.now()}-${Math.random().toString(36).substring(7)}.js`);
  const configPath = path.join(tempDir, `undomcp-test-config-${Date.now()}-${Math.random().toString(36).substring(7)}.yaml`);

  beforeAll(() => {
    // Write mock server code
    const mockServerCode = `
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false
      });

      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const req = JSON.parse(line);
          if (req.method === 'tools/list') {
            console.log(JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: {
                tools: [
                  {
                    name: 'get_data',
                    description: 'Get some data',
                    inputSchema: { type: 'object', properties: {} }
                  }
                ]
              }
            }));
          } else if (req.method === 'tools/call') {
            console.log(JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: {
                content: [{ type: 'text', text: 'Success: ' + req.params.name }]
              }
            }));
          } else if (req.method === 'initialize') {
            console.log(JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: {
                  tools: {},
                  logging: {}
                },
                serverInfo: {
                  name: 'mock-up-server',
                  version: '1.2.3'
                }
              }
            }));
          } else {
            console.log(JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: { echo: req.method }
            }));
          }
        } catch (e) {
          // ignore
        }
      });
    `;
    fs.writeFileSync(mockServerPath, mockServerCode);

    // Write mock config yaml
    const yamlContent = `
upstreams:
  srv1:
    command: node
    args:
      - "${mockServerPath.replace(/\\/g, '/')}"
  srv2:
    command: node
    args:
      - "${mockServerPath.replace(/\\/g, '/')}"
`;
    fs.writeFileSync(configPath, yamlContent);
  });

  afterAll(() => {
    try {
      if (fs.existsSync(mockServerPath)) fs.unlinkSync(mockServerPath);
      if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    } catch {}
  });

  it('should load multiple upstreams from config, aggregate tools with namespacing, route calls, and broadcast', async () => {
    const manager = new UpstreamManager(configPath);
    
    expect(manager.isMultiUpstream()).toBe(true);
    expect(manager.getNamespaces()).toEqual(['srv1', 'srv2']);

    const agentStderr = new PassThrough();
    manager.start(agentStderr);

    try {
      // Test listing all tools
      const tools = await manager.listAllTools();
      expect(tools.length).toBe(2);
      expect(tools[0].name).toBe('srv1__get_data');
      expect(tools[1].name).toBe('srv2__get_data');

      // Test routing tool call to specific namespace
      const callRes1 = await manager.routeCall('srv1__get_data', {});
      expect(callRes1.result.content[0].text).toBe('Success: get_data');

      const callRes2 = await manager.routeCall('srv2__get_data', {});
      expect(callRes2.result.content[0].text).toBe('Success: get_data');

      // Test broadcast initialization
      const initRes = await manager.broadcast('initialize', {});
      expect(initRes.result.protocolVersion).toBe('2024-11-05');
      expect(initRes.result.capabilities).toHaveProperty('tools');
      expect(initRes.result.serverInfo.name).toContain('mock-up-server');

      // Test general broadcast ping
      const pingRes = await manager.broadcast('ping', {});
      expect(pingRes.result.echo).toBe('ping');

    } finally {
      manager.stop();
    }
  });
});
