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
      'sqlite.js',
      '--no-tools'
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
      '--args',
      '--no-tools'
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
    // 1. Create mock config files for multiple IDEs to test skill installation
    const mockEmptyPath = path.join(tempDir, `empty-mcp-test-${Date.now()}-${Math.random().toString(36).substring(7)}.json`);
    const mockClaudeTestPath = path.join(tempDir, `claude-test-${Date.now()}.json`);
    const mockCursorTestPath = path.join(tempDir, `cursor-test-${Date.now()}.json`);
    fs.writeFileSync(mockEmptyPath, '{}', 'utf8');
    fs.writeFileSync(mockClaudeTestPath, '{}', 'utf8');
    fs.writeFileSync(mockCursorTestPath, '{}', 'utf8');

    // 2. Configure override paths for multiple clients to test conditional skill installation
    setClientConfigsOverride([
      {
        name: 'OpenCode',
        paths: [mockEmptyPath]
      },
      {
        name: 'Claude Code',
        paths: [mockClaudeTestPath]
      },
      {
        name: 'Cursor',
        paths: [mockCursorTestPath]
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
      expect(content.mcp.undomcp.args).toEqual(['serve']);

      // Verify skills were installed ONLY for detected IDEs
      const claudeSkillPath = path.join(tempDir, '.claude/skills/undomcp/SKILL.md');
      const geminiSkillPath = path.join(tempDir, '.gemini/config/skills/undomcp/SKILL.md');
      const windsurfGlobalRules = path.join(tempDir, '.codeium/windsurf/memories/global_rules.md');
      const cursorRules = path.join(tempDir, '.cursorrules');
      const cursorMdc = path.join(tempDir, '.cursor/rules/undomcp.mdc');
      const windsurfRules = path.join(tempDir, '.windsurfrules');
      const windsurfMdc = path.join(tempDir, '.windsurf/rules/undomcp.md');

      // Claude Code and Cursor are detected — their skills SHOULD be installed
      expect(fs.existsSync(claudeSkillPath)).toBe(true);
      expect(fs.existsSync(cursorRules)).toBe(true);
      expect(fs.existsSync(cursorMdc)).toBe(true);

      // Windsurf and Gemini/Antigravity are NOT detected — their skills should NOT be installed
      expect(fs.existsSync(geminiSkillPath)).toBe(false);
      expect(fs.existsSync(windsurfGlobalRules)).toBe(false);
      expect(fs.existsSync(windsurfRules)).toBe(false);
      expect(fs.existsSync(windsurfMdc)).toBe(false);

      // Run restore
      await runSetup({ restore: true, binaryPath: '/mock/bin/undomcp' });

      // Verify undomcp standalone was removed
      const restoredContent = JSON.parse(fs.readFileSync(mockEmptyPath, 'utf8'));
      expect(restoredContent.mcp.undomcp).toBeUndefined();

      // Verify skills were removed
      expect(fs.existsSync(claudeSkillPath)).toBe(false);
      expect(fs.existsSync(cursorRules)).toBe(false);
      expect(fs.existsSync(cursorMdc)).toBe(false);
    } finally {
      for (const f of [mockEmptyPath, mockClaudeTestPath, mockCursorTestPath]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
        if (fs.existsSync(f + '.undomcp-backup')) fs.unlinkSync(f + '.undomcp-backup');
      }
      // Restore the mock paths to Cursor/Claude Code so other tests aren't affected
      setClientConfigsOverride([
        { name: 'Cursor', paths: [mockCursorPath] },
        { name: 'Claude Code', paths: [mockClaudePath] }
      ]);
    }
  });

  it('should support Zed configuration format with command objects', async () => {
    const mockZedPath = path.join(tempDir, `zed-test-${Date.now()}.json`);
    const zedConfig = {
      context_servers: {
        "my-server": {
          command: {
            path: "npx",
            args: ["-y", "sqlite"],
            env: { KEY: "val" }
          }
        }
      }
    };
    fs.writeFileSync(mockZedPath, JSON.stringify(zedConfig, null, 2), 'utf8');
    setClientConfigsOverride([{ name: 'Zed', paths: [mockZedPath] }]);

    try {
      await runSetup({ binaryPath: '/mock/bin/undomcp', all: true });

      const content = JSON.parse(fs.readFileSync(mockZedPath, 'utf8'));
      expect(content.context_servers["my-server"].command.path).toBe('/mock/bin/undomcp');
      expect(content.context_servers["my-server"].command.args[0]).toBe('serve');
      expect(content.context_servers.undomcp.command.path).toBe('/mock/bin/undomcp');

      await runSetup({ restore: true, binaryPath: '/mock/bin/undomcp' });

      const restored = JSON.parse(fs.readFileSync(mockZedPath, 'utf8'));
      expect(restored.context_servers["my-server"].command.path).toBe('npx');
      expect(restored.context_servers.undomcp).toBeUndefined();
    } finally {
      if (fs.existsSync(mockZedPath)) fs.unlinkSync(mockZedPath);
      if (fs.existsSync(mockZedPath + '.undomcp-backup')) fs.unlinkSync(mockZedPath + '.undomcp-backup');
    }
  });

  it('should support Continue configuration format with arrays', async () => {
    const mockContinuePath = path.join(tempDir, `continue-test-${Date.now()}.json`);
    const continueConfig = {
      mcpServers: [
        {
          name: "my-server",
          command: "node",
          args: ["index.js"]
        }
      ]
    };
    fs.writeFileSync(mockContinuePath, JSON.stringify(continueConfig, null, 2), 'utf8');
    setClientConfigsOverride([{ name: 'Continue', paths: [mockContinuePath] }]);

    try {
      await runSetup({ binaryPath: '/mock/bin/undomcp', all: true });

      const content = JSON.parse(fs.readFileSync(mockContinuePath, 'utf8'));
      expect(content.mcpServers[0].command).toBe('/mock/bin/undomcp');
      expect(content.mcpServers[1].name).toBe('undomcp');
      expect(content.mcpServers[1].command).toBe('/mock/bin/undomcp');

      await runSetup({ restore: true, binaryPath: '/mock/bin/undomcp' });

      const restored = JSON.parse(fs.readFileSync(mockContinuePath, 'utf8'));
      expect(restored.mcpServers).toHaveLength(1);
      expect(restored.mcpServers[0].command).toBe('node');
    } finally {
      if (fs.existsSync(mockContinuePath)) fs.unlinkSync(mockContinuePath);
      if (fs.existsSync(mockContinuePath + '.undomcp-backup')) fs.unlinkSync(mockContinuePath + '.undomcp-backup');
    }
  });

  it('should wrap HTTP servers with explicit auth by rewriting URL to local proxy', async () => {
    const mockHttpPath = path.join(tempDir, `http-mcp-test-${Date.now()}.json`);

    const mockConfig = {
      mcpServers: {
        'apikey-server': {
          type: 'http',
          url: 'https://api.example.com/mcp',
          headers: { 'Authorization': 'Bearer sk_secret_key' }
        },
        'stdio-server': {
          command: 'node',
          args: ['server.js']
        }
      }
    };
    fs.writeFileSync(mockHttpPath, JSON.stringify(mockConfig, null, 2), 'utf8');

    setClientConfigsOverride([{ name: 'Claude Code', paths: [mockHttpPath] }]);

    try {
      await runSetup({ binaryPath: '/mock/bin/undomcp', all: true });

      const content = JSON.parse(fs.readFileSync(mockHttpPath, 'utf8'));

      // HTTP server with explicit auth should have URL rewritten to local proxy
      expect(content.mcpServers['apikey-server'].__originalUrl).toBe('https://api.example.com/mcp');
      expect(content.mcpServers['apikey-server'].url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/proxy\/apikey-server\/$/);
      expect(content.mcpServers['apikey-server'].type).toBe('http');
      expect(content.mcpServers['apikey-server'].headers).toEqual({ 'Authorization': 'Bearer sk_secret_key' });

      // stdio server should still be wrapped normally
      expect(content.mcpServers['stdio-server'].command).toBe('/mock/bin/undomcp');

      // Restore
      await runSetup({ restore: true, binaryPath: '/mock/bin/undomcp' });

      const restored = JSON.parse(fs.readFileSync(mockHttpPath, 'utf8'));
      expect(restored.mcpServers['apikey-server'].url).toBe('https://api.example.com/mcp');
      expect(restored.mcpServers['apikey-server'].__originalUrl).toBeUndefined();
    } finally {
      setClientConfigsOverride(null);
      if (fs.existsSync(mockHttpPath)) fs.unlinkSync(mockHttpPath);
      if (fs.existsSync(mockHttpPath + '.undomcp-backup')) fs.unlinkSync(mockHttpPath + '.undomcp-backup');
    }
  });

  it('should mark OAuth HTTP servers as tracked without rewriting URL', async () => {
    const mockHttpPath = path.join(tempDir, `oauth-mcp-test-${Date.now()}.json`);

    const mockConfig = {
      mcpServers: {
        'notion': {
          type: 'http',
          url: 'https://mcp.notion.com/mcp'
        }
      }
    };
    fs.writeFileSync(mockHttpPath, JSON.stringify(mockConfig, null, 2), 'utf8');

    setClientConfigsOverride([{ name: 'Claude Code', paths: [mockHttpPath] }]);

    try {
      await runSetup({ binaryPath: '/mock/bin/undomcp', all: true });

      const content = JSON.parse(fs.readFileSync(mockHttpPath, 'utf8'));

      // OAuth server should NOT have URL rewritten (would break OAuth)
      expect(content.mcpServers['notion'].url).toBe('https://mcp.notion.com/mcp');
      expect(content.mcpServers['notion'].__originalUrl).toBeUndefined();
      expect(content.mcpServers['notion'].__undomcp_disabled).toBe(true);

      // Restore
      await runSetup({ restore: true, binaryPath: '/mock/bin/undomcp' });

      const restored = JSON.parse(fs.readFileSync(mockHttpPath, 'utf8'));
      expect(restored.mcpServers['notion'].url).toBe('https://mcp.notion.com/mcp');
      expect(restored.mcpServers['notion'].__undomcp_disabled).toBeUndefined();
    } finally {
      setClientConfigsOverride(null);
      if (fs.existsSync(mockHttpPath)) fs.unlinkSync(mockHttpPath);
      if (fs.existsSync(mockHttpPath + '.undomcp-backup')) fs.unlinkSync(mockHttpPath + '.undomcp-backup');
    }
  });
});

