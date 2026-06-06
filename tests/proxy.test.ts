import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'stream';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ProxyEngine } from '../src/proxy/engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mockServerPath = path.join(__dirname, 'mocks', 'mock-server.js');

describe('ProxyEngine stdio JSON-RPC Interceptor', () => {
  it('should forward requests and responses, triggering callbacks', () => {
    return new Promise<void>((resolve, reject) => {
      const agentStdin = new PassThrough();
      const agentStdout = new PassThrough();
      const agentStderr = new PassThrough();

      const onRequest = vi.fn();
      const onResponse = vi.fn();

      const proxy = new ProxyEngine({
        command: 'node',
        args: [mockServerPath],
        onRequest,
        onResponse,
      });

      // Start the proxy
      proxy.start(agentStdin, agentStdout, agentStderr);

      // Collect data written to agentStdout
      let outputBuffer = '';
      agentStdout.on('data', (chunk) => {
        outputBuffer += chunk.toString();
        
        // If we received a complete response line, verify it
        if (outputBuffer.includes('\n')) {
          const lines = outputBuffer.trim().split('\n');
          const lastLine = lines[lines.length - 1];
          try {
            const parsedResponse = JSON.parse(lastLine);
            
            if (parsedResponse.id === 1) {
              // Verify list tools response
              expect(parsedResponse.result.tools[0].name).toBe('mock_tool');
              expect(onRequest).toHaveBeenCalledTimes(1);
              expect(onRequest).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'tools/list', id: 1 }));
              
              // Now call a tool
              const toolCallRequest = {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                  name: 'mock_tool',
                  arguments: { testKey: 'testVal' },
                },
              };
              agentStdin.write(JSON.stringify(toolCallRequest) + '\n');
            } else if (parsedResponse.id === 2) {
              // Verify tool call response
              expect(parsedResponse.result.content[0].text).toContain('testKey');
              expect(onRequest).toHaveBeenCalledTimes(2);
              expect(onResponse).toHaveBeenCalledTimes(2);
              
              // Verify specific details of callback arguments
              expect(onResponse).toHaveBeenLastCalledWith(
                expect.objectContaining({ method: 'tools/call', id: 2 }),
                expect.objectContaining({ id: 2, result: expect.anything() })
              );

              // Cleanup
              proxy.stop();
              resolve();
            }
          } catch (err) {
            proxy.stop();
            reject(err);
          }
        }
      });

      // Send first request: list tools
      const listRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      };
      agentStdin.write(JSON.stringify(listRequest) + '\n');
    });
  }, 10000); // 10s timeout
});
