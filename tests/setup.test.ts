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
      // Clean up backup files
      if (fs.existsSync(mockCursorPath + '.undomcp-backup')) fs.unlinkSync(mockCursorPath + '.undomcp-backup');
      if (fs.existsSync(mockClaudePath + '.undomcp-backup')) fs.unlinkSync(mockClaudePath + '.undomcp-backup');
      // Clean up mock skill directories
      const claudeSkillsDir = path.join(tempDir, '.claude');
      const geminiSkillsDir = path.join(tempDir, '.gemini');
      if (fs.existsSync(claudeSkillsDir)) fs.rmSync(claudeSkillsDir, { recursive: true, force: true });
      if (fs.existsSync(geminiSkillsDir)) fs.rmSync(geminiSkillsDir, { recursive: true, force: true });
    } catch {}
  });

  it('should wrap client server command configurations, then restore them cleanly', async () => {
    // Run setup with --all to bypass interactive selection
    await runSetup({ binaryPath: '/mock/bin/undomcp', all: true });

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

  it('should create backup files before wrapping configs', async () => {
    // Re-write fresh configs for backup test
    const cursorConfig = {
      mcpServers: {
        'test-server': { command: 'test-cmd', args: ['--flag'] }
      }
    };
    fs.writeFileSync(mockCursorPath, JSON.stringify(cursorConfig, null, 2), 'utf8');
    // Remove any stale backup
    const backupPath = mockCursorPath + '.undomcp-backup';
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

    await runSetup({ binaryPath: '/mock/bin/undomcp', all: true });

    // Verify backup was created
    expect(fs.existsSync(backupPath)).toBe(true);

    // Verify backup contains the original unwrapped config
    const backupContent = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    expect(backupContent.mcpServers['test-server'].command).toBe('test-cmd');
    expect(backupContent.mcpServers['test-server'].__originalCommand).toBeUndefined();

    // Restore
    await runSetup({ restore: true, binaryPath: '/mock/bin/undomcp' });
  });

  it('should auto-initialize empty configs and register standalone undomcp, then remove it on restore', async () => {
    // 1. Create a mock file that is empty JSON
    const mockEmptyPath = path.join(tempDir, `empty-mcp-test-${Date.now()}-${Math.random().toString(36).substring(7)}.json`);
    fs.writeFileSync(mockEmptyPath, '{}', 'utf8');

    // 2. Configure override paths for a custom client
    setClientConfigsOverride([
      {
        name: 'OpenCode',
        paths: [mockEmptyPath]
      }
    ]);

    try {
      // Run setup
      await runSetup({ binaryPath: '/mock/bin/undomcp', all: true });

      // Verify it initialized the 'mcp' key and registered undomcp standalone
      const content = JSON.parse(fs.readFileSync(mockEmptyPath, 'utf8'));
      expect(content.mcp).toBeDefined();
      expect(content.mcp.undomcp).toBeDefined();
      expect(content.mcp.undomcp.command).toBe('/mock/bin/undomcp');
      expect(content.mcp.undomcp.args).toEqual(['serve', '--command', 'node', '--args', '-e', '""']);

      // Verify skills were installed
      const claudeSkillPath = path.join(tempDir, '.claude/skills/undomcp/SKILL.md');
      const geminiSkillPath = path.join(tempDir, '.gemini/config/skills/undomcp/SKILL.md');
      const windsurfGlobalRules = path.join(tempDir, '.codeium/windsurf/memories/global_rules.md');
      const cursorRules = path.join(tempDir, '.cursorrules');
      const cursorMdc = path.join(tempDir, '.cursor/rules/undomcp.mdc');
      const windsurfRules = path.join(tempDir, '.windsurfrules');
      const windsurfMdc = path.join(tempDir, '.windsurf/rules/undomcp.md');

      expect(fs.existsSync(claudeSkillPath)).toBe(true);
      expect(fs.existsSync(geminiSkillPath)).toBe(true);
      expect(fs.existsSync(windsurfGlobalRules)).toBe(true);
      expect(fs.existsSync(cursorRules)).toBe(true);
      expect(fs.existsSync(cursorMdc)).toBe(true);
      expect(fs.existsSync(windsurfRules)).toBe(true);
      expect(fs.existsSync(windsurfMdc)).toBe(true);

      // Run restore
      await runSetup({ restore: true, binaryPath: '/mock/bin/undomcp' });

      // Verify undomcp standalone was removed
      const restoredContent = JSON.parse(fs.readFileSync(mockEmptyPath, 'utf8'));
      expect(restoredContent.mcp.undomcp).toBeUndefined();

      // Verify skills were removed
      expect(fs.existsSync(claudeSkillPath)).toBe(false);
      expect(fs.existsSync(geminiSkillPath)).toBe(false);
      expect(fs.existsSync(windsurfGlobalRules)).toBe(false);
      expect(fs.existsSync(cursorRules)).toBe(false);
      expect(fs.existsSync(cursorMdc)).toBe(false);
      expect(fs.existsSync(windsurfRules)).toBe(false);
      expect(fs.existsSync(windsurfMdc)).toBe(false);
    } finally {
      if (fs.existsSync(mockEmptyPath)) fs.unlinkSync(mockEmptyPath);
      if (fs.existsSync(mockEmptyPath + '.undomcp-backup')) fs.unlinkSync(mockEmptyPath + '.undomcp-backup');
      // Restore the mock paths to Cursor/Claude Code so other tests aren't affected
      setClientConfigsOverride([
        { name: 'Cursor', paths: [mockCursorPath] },
        { name: 'Claude Code', paths: [mockClaudePath] }
      ]);
    }
  });
});
