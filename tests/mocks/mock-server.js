import * as readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: undefined,
  historySize: 0,
});

rl.on('line', (line) => {
  if (!line.trim()) return;

  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    return;
  }

  // Handle standard JSON-RPC requests
  if (request && request.id !== undefined && request.method !== undefined) {
    let response;

    if (request.method === 'tools/list') {
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            {
              name: 'mock_tool',
              description: 'A mock tool for testing',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      };
    } else if (request.method === 'tools/call') {
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          content: [
            {
              type: 'text',
              text: `Echo: ${JSON.stringify(request.params?.arguments || {})}`,
            },
          ],
        },
      };
    } else {
      // Default echo
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          echoedMethod: request.method,
          echoedParams: request.params,
        },
      };
    }

    process.stdout.write(JSON.stringify(response) + '\n');
  }
});
