import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runSetup, setClientConfigsOverride } from '../src/commands/setup.js';

const tempDir = os.tmpdir();
const mockCursorPath = path.join(tempDir, `cursor-mcp-test-${Date.now()}-${Math.random().toString(36).substring(7)}.json`);
const mockClaudePath = path.join(tempDir, `claude-mcp-test-${Date.now()}-${Math.random().toString(36).substring(7)}.json`);

describe('setup command', () => {
  beforeAll(() => {
    // Configure override paths
    setClientConfigsOverride([
      {
        name: 'Cursor',
        paths: [mockCursorPath]
      },
      {
        name: 'Claude Code',
        paths: [mockClaudePath]
      }
    ]);

    // Write original mock configurations
    const mockCursorConfig = {
      mcpServers: {
        'sqlite-server': {
          command: 'node',
          args: ['sqlite.js'],
          env: { DB_PATH: 'test.db' }
        },
        'undomcp': {
          command: 'undomcp',
          args: ['serve']
        }
      }
    };
    const mockClaudeConfig = {
      mcpServers: {
        'gcal-server': {
          command: 'gcal-mcp',
          args: []
        }
      }
    };

    fs.writeFileSync(mockCursorPath, JSON.stringify(mockCursorConfig, null, 2), 'utf8');
    fs.writeFileSync(mockClaudePath, JSON.stringify(mockClaudeConfig, null, 2), 'utf8');
  });

  afterAll(() => {
    setClientConfigsOverride(null);
    try {
      if (fs.existsSync(mockCursorPath)) fs.unlinkSync(mockCursorPath);
      if (fs.existsSync(mockClaudePath)) fs.unlinkSync(mockClaudePath);
    } catch {}
  });

  it('should wrap client server command configurations, then restore them cleanly', async () => {
    // Run setup
    await runSetup({ binaryPath: '/mock/bin/undomcp' });

    // Verify Cursor config is wrapped
    const cursorContent = JSON.parse(fs.readFileSync(mockCursorPath, 'utf8'));
    expect(cursorContent.mcpServers['sqlite-server'].command).toBe('/mock/bin/undomcp');
    expect(cursorContent.mcpServers['sqlite-server'].args).toEqual([
      'serve',
      '--command',
      'node',
      '--args',
      'sqlite.js'
    ]);
    expect(cursorContent.mcpServers['sqlite-server'].__originalCommand).toBe('node');
    expect(cursorContent.mcpServers['sqlite-server'].__originalArgs).toEqual(['sqlite.js']);
    expect(cursorContent.mcpServers['sqlite-server'].env).toEqual({ DB_PATH: 'test.db' });
    
    // Check that undomcp server config itself was not wrapped
    expect(cursorContent.mcpServers['undomcp'].command).toBe('undomcp');
    expect(cursorContent.mcpServers['undomcp'].__originalCommand).toBeUndefined();

    // Verify Claude config is wrapped
    const claudeContent = JSON.parse(fs.readFileSync(mockClaudePath, 'utf8'));
    expect(claudeContent.mcpServers['gcal-server'].command).toBe('/mock/bin/undomcp');
    expect(claudeContent.mcpServers['gcal-server'].args).toEqual([
      'serve',
      '--command',
      'gcal-mcp',
      '--args'
    ]);

    // Now restore configs
    await runSetup({ restore: true, binaryPath: '/mock/bin/undomcp' });

    // Verify Cursor config is restored
    const cursorRestored = JSON.parse(fs.readFileSync(mockCursorPath, 'utf8'));
    expect(cursorRestored.mcpServers['sqlite-server'].command).toBe('node');
    expect(cursorRestored.mcpServers['sqlite-server'].args).toEqual(['sqlite.js']);
    expect(cursorRestored.mcpServers['sqlite-server'].__originalCommand).toBeUndefined();
    expect(cursorRestored.mcpServers['sqlite-server'].__originalArgs).toBeUndefined();

    // Verify Claude config is restored
    const claudeRestored = JSON.parse(fs.readFileSync(mockClaudePath, 'utf8'));
    expect(claudeRestored.mcpServers['gcal-server'].command).toBe('gcal-mcp');
    expect(claudeRestored.mcpServers['gcal-server'].args).toEqual([]);
    expect(claudeRestored.mcpServers['gcal-server'].__originalCommand).toBeUndefined();
  });
});
