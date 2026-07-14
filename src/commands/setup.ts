import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

export function parseJsonc(content: string): any {
  // Strip comments (both single line and multi-line)
  const clean = content.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m);
  return JSON.parse(clean);
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

export interface ClientConfig {
  name: string;
  paths: string[];
}

let overrideClientConfigs: ClientConfig[] | null = null;

export function setClientConfigsOverride(configs: ClientConfig[] | null): void {
  overrideClientConfigs = configs;
}

export function getClientConfigs(): ClientConfig[] {
  if (overrideClientConfigs) {
    return overrideClientConfigs;
  }
  const home = os.homedir();
  const appData = process.env.APPDATA || (process.platform === 'darwin' ? path.join(home, 'Library/Application Support') : path.join(home, '.config'));
  const configDir = process.platform === 'win32' ? appData : path.join(home, '.config');

  return [
    {
      name: 'Cursor',
      paths: [
        path.join(appData, 'Cursor/User/globalStorage/moosemu.mcp-connector-client/config.json'),
        path.join(home, '.cursor/mcp.json')
      ]
    },
    {
      name: 'Claude Code',
      paths: [
        path.join(home, '.claude.json'),
        path.join(home, '.claude/mcp.json')
      ]
    },
    {
      name: 'Claude Desktop',
      paths: [
        process.platform === 'win32'
          ? path.join(appData, 'Claude/claude_desktop_config.json')
          : process.platform === 'darwin'
            ? path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json')
            : path.join(configDir, 'Claude/claude_desktop_config.json')
      ]
    },
    {
      name: 'Windsurf',
      paths: [
        path.join(home, '.codeium/windsurf/mcp_config.json')
      ]
    },
    {
      name: 'Codex CLI',
      paths: [
        path.join(home, '.codex/mcp.json'),
        path.join(configDir, 'codex/mcp.json')
      ]
    },
    {
      name: 'Antigravity (Gemini)',
      paths: [
        path.join(home, '.gemini/config/mcp_config.json'),
        path.join(home, '.gemini/settings.json'),
        path.join(configDir, 'gemini/settings.json')
      ]
    },
    {
      name: 'VS Code Copilot',
      paths: [
        path.join(appData, 'Code/User/mcp.json'),
        path.join(appData, 'Code - Insiders/User/mcp.json'),
        path.join(appData, 'Code/User/settings.json'),
        path.join(appData, 'Code - Insiders/User/settings.json'),
        path.join(appData, 'VSCodium/User/mcp.json'),
        path.join(appData, 'VSCodium/User/settings.json')
      ]
    },
    {
      name: 'OpenCode',
      paths: [
        path.join(home, '.config/opencode/opencode.json'),
        path.join(home, '.opencode.json'),
        path.join(appData, 'opencode/opencode.json'),
        path.join(configDir, 'opencode/opencode.json')
      ]
    },
    {
      name: 'Kilo Code',
      paths: [
        path.join(appData, 'Code/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json'),
        path.join(appData, 'Code - Insiders/User/globalStorage/kilocode.kilo-code/settings/mcp_settings.json'),
        path.join(home, '.kilocode/mcp.json'),
        path.join(configDir, 'kilocode/mcp.json')
      ]
    },
    {
      name: 'Cline',
      paths: [
        path.join(appData, 'Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'),
        path.join(appData, 'Code - Insiders/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'),
        path.join(appData, 'VSCodium/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json')
      ]
    },
    {
      name: 'Roo Code',
      paths: [
        path.join(appData, 'Code/User/globalStorage/roocode.roo-cline/settings/cline_mcp_settings.json'),
        path.join(appData, 'Code - Insiders/User/globalStorage/roocode.roo-cline/settings/cline_mcp_settings.json'),
        path.join(appData, 'VSCodium/User/globalStorage/roocode.roo-cline/settings/cline_mcp_settings.json')
      ]
    },
    {
      name: 'Continue',
      paths: [
        path.join(home, '.continue/config.json')
      ]
    },
    {
      name: 'Zed',
      paths: [
        path.join(configDir, 'zed/settings.json'),
        path.join(appData, 'Zed/settings.json')
      ]
    },
    {
      name: 'JetBrains IDEs',
      paths: [
        path.join(appData, 'JetBrains/mcp.json'),
        path.join(configDir, 'JetBrains/mcp.json')
      ]
    },
    {
      name: 'Amazon Q',
      paths: [
        path.join(home, '.aws/amazonq/mcp.json'),
        path.join(appData, 'amazon-q/mcp.json')
      ]
    },
    {
      name: 'Aider',
      paths: [
        path.join(home, '.aider/mcp.json'),
        path.join(configDir, 'aider/mcp.json')
      ]
    }
  ];
}

/**
 * Detects which IDE configs actually exist on disk.
 * Returns a deduplicated list of { name, foundPath } entries.
 */
export function detectInstalledClients(): { name: string; foundPath: string }[] {
  const configs = getClientConfigs();
  const found: { name: string; foundPath: string }[] = [];

  for (const config of configs) {
    for (const configPath of config.paths) {
      if (fs.existsSync(configPath)) {
        found.push({ name: config.name, foundPath: configPath });
        break; // Only report the first found path per IDE
      }
    }
  }
  return found;
}

/**
 * Interactive IDE selection TUI.
 * Shows detected IDEs with checkboxes and lets the user toggle selections.
 */
export async function selectIdesInteractively(
  detectedClients: { name: string; foundPath: string }[]
): Promise<{ name: string; foundPath: string }[]> {
  if (detectedClients.length === 0) {
    return [];
  }

  return new Promise((resolve) => {
    const items = detectedClients.map((c) => ({
      name: c.name,
      foundPath: c.foundPath,
      selected: true, // All selected by default
    }));

    let cursorIndex = 0; // Start on "Select All"
    let selectAll = true;
    let lastRenderedLines = 0;

    function moveCursorUp(lines: number) {
      if (lines > 0) {
        process.stdout.write(`\x1b[${lines}A`);
      }
    }

    function render() {
      // Clear previous output
      if (lastRenderedLines > 0) {
        moveCursorUp(lastRenderedLines);
        process.stdout.write('\x1b[J');
      }

      const lines: string[] = [];
      lines.push('');
      lines.push('\x1b[1m\x1b[36m╔══════════════════════════════════════════════════╗\x1b[0m');
      lines.push('\x1b[1m\x1b[36m║     UndoMCP — IDE Configuration Setup           ║\x1b[0m');
      lines.push('\x1b[1m\x1b[36m╚══════════════════════════════════════════════════╝\x1b[0m');
      lines.push('');
      lines.push('  Select which AI agents/IDEs to configure:');
      lines.push('  \x1b[2m(Use ↑/↓ to navigate, Space to toggle, Enter to confirm, q to cancel)\x1b[0m');
      lines.push('');

      // "Select All" row
      const allPointer = cursorIndex === 0 ? '\x1b[36m➔\x1b[0m ' : '  ';
      const allBox = selectAll ? '\x1b[32m[✓]\x1b[0m' : '[ ]';
      const allStyle = cursorIndex === 0 ? '\x1b[1m\x1b[36m' : '\x1b[1m';
      lines.push(`  ${allPointer}${allBox} ${allStyle}Select All\x1b[0m`);
      lines.push('  \x1b[2m' + '─'.repeat(44) + '\x1b[0m');

      // Individual IDE rows
      items.forEach((item, index) => {
        const rowIndex = index + 1; // offset by 1 because Select All is at 0
        const pointer = cursorIndex === rowIndex ? '\x1b[36m➔\x1b[0m ' : '  ';
        const box = item.selected ? '\x1b[32m[✓]\x1b[0m' : '[ ]';
        const nameStyle = cursorIndex === rowIndex ? '\x1b[1m\x1b[36m' : '';
        const pathDisplay = `\x1b[2m${shortenPath(item.foundPath)}\x1b[0m`;
        lines.push(`  ${pointer}${box} ${nameStyle}${item.name}\x1b[0m  ${pathDisplay}`);
      });

      lines.push('');

      const selectedCount = items.filter((i) => i.selected).length;
      lines.push(`  \x1b[2m${selectedCount} of ${items.length} selected\x1b[0m`);
      lines.push('');

      const output = lines.join('\n') + '\n';
      process.stdout.write(output);
      lastRenderedLines = output.split('\n').length - 1;
    }

    function updateSelectAll() {
      selectAll = items.every((i) => i.selected);
    }

    const totalRows = items.length + 1; // +1 for "Select All"

    const onKeypress = (str: string, key: any) => {
      if (!key) return;

      if ((key.ctrl && key.name === 'c') || key.name === 'q') {
        cleanup();
        console.log('\n\x1b[33mSetup cancelled.\x1b[0m');
        resolve([]);
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        cursorIndex = (cursorIndex - 1 + totalRows) % totalRows;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        cursorIndex = (cursorIndex + 1) % totalRows;
        render();
      } else if (key.name === 'space') {
        if (cursorIndex === 0) {
          // Toggle "Select All"
          selectAll = !selectAll;
          items.forEach((i) => (i.selected = selectAll));
        } else {
          const itemIndex = cursorIndex - 1;
          items[itemIndex].selected = !items[itemIndex].selected;
          updateSelectAll();
        }
        render();
      } else if (key.name === 'return') {
        cleanup();
        const selected = items.filter((i) => i.selected);
        if (selected.length === 0) {
          console.log('\n\x1b[33mNo IDEs selected. Setup cancelled.\x1b[0m');
        } else {
          console.log(`\n\x1b[32m✔ Configuring ${selected.length} IDE(s)...\x1b[0m\n`);
        }
        resolve(selected.map((i) => ({ name: i.name, foundPath: i.foundPath })));
        return;
      }
    };

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    }

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('keypress', onKeypress);

    render();
  });
}

/**
 * Shortens a file path for display by replacing the home directory with ~.
 */
function shortenPath(filePath: string): string {
  const home = os.homedir();
  if (filePath.startsWith(home)) {
    return '~' + filePath.slice(home.length).replace(/\\/g, '/');
  }
  return filePath.replace(/\\/g, '/');
}

/**
 * Creates a backup of a config file before modifying it.
 * Returns the backup path, or null if backup was skipped.
 */
function backupConfigFile(configPath: string): string | null {
  const backupPath = configPath + '.undomcp-backup';
  // Only create backup if one doesn't already exist (preserve the original)
  if (!fs.existsSync(backupPath)) {
    try {
      fs.copyFileSync(configPath, backupPath);
      return backupPath;
    } catch (err: any) {
      console.error(`[undomcp] Failed to backup ${configPath}: ${err.message}`);
      return null;
    }
  }
  return backupPath;
}

function getServersKeyForConfig(clientName: string, configPath: string, parsed: any): string {
  if (parsed.mcpServers && typeof parsed.mcpServers === 'object') return 'mcpServers';
  if (parsed.mcp_servers && typeof parsed.mcp_servers === 'object') return 'mcp_servers';
  if (parsed.mcp && typeof parsed.mcp === 'object') return 'mcp';
  if (parsed.context_servers && typeof parsed.context_servers === 'object') return 'context_servers';
  if (parsed.servers && typeof parsed.servers === 'object') return 'servers';
  if (parsed['github.copilot.chat.mcp.servers'] && typeof parsed['github.copilot.chat.mcp.servers'] === 'object') return 'github.copilot.chat.mcp.servers';

  const fileName = path.basename(configPath).toLowerCase();
  if (clientName === 'Zed') {
    return 'context_servers';
  }
  if (clientName === 'OpenCode') {
    return 'mcp';
  }
  if (clientName === 'VS Code Copilot' && fileName === 'settings.json') {
    return 'github.copilot.chat.mcp.servers';
  }
  if (clientName === 'VS Code Copilot' && fileName === 'mcp.json') {
    return 'servers';
  }
  return 'mcpServers';
}

export interface SetupOptions {
  restore?: boolean;
  binaryPath?: string;
  /** Skip interactive selection — configure all detected IDEs (for CI and tests). */
  all?: boolean;
  /** Pre-selected client list — bypasses both detection and interactive selection (for programmatic use). */
  selectedClients?: { name: string; foundPath: string }[];
}

async function resolveUndomcpBinary(explicitPath?: string): Promise<string> {
  if (explicitPath) return explicitPath;

  const { execSync } = await import('child_process');

  // 1. Try to find 'undomcp' in PATH
  try {
    const whichCmd = process.platform === 'win32' ? 'where undomcp' : 'which undomcp';
    const found = execSync(whichCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0];
    if (found && !found.endsWith('node') && !found.endsWith('node.exe')) {
      return found;
    }
  } catch {
    // Not in PATH
  }

  // 2. Try global npm prefix
  try {
    const prefix = execSync('npm prefix -g', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const globalPath = process.platform === 'win32'
      ? path.join(prefix, 'undomcp.cmd')
      : path.join(prefix, 'bin/undomcp');
    if (fs.existsSync(globalPath)) {
      return globalPath;
    }
  } catch {
    // ignore prefix resolution failures
  }

  // 3. Check if we're running as a compiled binary (not via node)
  const isCompiled = !process.argv[1] || !process.argv[1].endsWith('.js');
  if (isCompiled && !process.argv[0].endsWith('node') && !process.argv[0].endsWith('node.exe')) {
    return process.argv[0];
  }

  // 4. If we are running via node and the script path exists, return that script path
  if (process.argv[1] && fs.existsSync(process.argv[1])) {
    return path.resolve(process.argv[1]);
  }

  // Last resort: assume 'undomcp' will be in PATH
  return 'undomcp';
}

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  const configs = getClientConfigs();

  // Resolve the undomcp binary path reliably:
  // 1. Explicit --binary-path flag (highest priority)
  // 2. Check if 'undomcp' is in PATH (works after npm install -g or npm link)
  // 3. Fall back to process.argv[0] for compiled single-binary distributions
  // 4. Last resort: bare 'undomcp' (assumes it will be in PATH)
  const undomcpBin = await resolveUndomcpBinary(options.binaryPath);

  // --- Determine which config files to process ---
  let targetPaths: Set<string>;

  if (options.restore) {
    // Restore mode: process ALL config files that exist (no selection needed)
    targetPaths = new Set<string>();
    for (const config of configs) {
      for (const configPath of config.paths) {
        if (fs.existsSync(configPath)) {
          targetPaths.add(configPath);
        }
      }
    }
  } else if (options.selectedClients) {
    // Programmatic mode: use pre-supplied selection
    targetPaths = new Set(options.selectedClients.map((c) => c.foundPath));
  } else if (options.all) {
    // Non-interactive --all flag: configure every detected IDE
    const detected = detectInstalledClients();
    if (detected.length === 0) {
      console.log('[undomcp] No AI agent configuration files found on this system.');
      return;
    }
    targetPaths = new Set(detected.map((c) => c.foundPath));
    console.log(`[undomcp] Found ${detected.length} AI agent(s): ${detected.map((c) => c.name).join(', ')}`);
  } else {
    // Interactive mode: detect and let user select
    const detected = detectInstalledClients();
    if (detected.length === 0) {
      console.log('[undomcp] No AI agent configuration files found on this system.');
      console.log('[undomcp] You can manually add undomcp to your MCP config. See: https://github.com/LokeyDev0/UndoMCP-Tool#manual-setup');
      return;
    }

    const isInteractive = process.stdin.isTTY;
    let selected: { name: string; foundPath: string }[];

    if (isInteractive) {
      selected = await selectIdesInteractively(detected);
      if (selected.length === 0) {
        return; // User cancelled
      }
    } else {
      // Non-interactive (piped install script) — default to all
      console.log(`[undomcp] Non-interactive mode. Configuring all ${detected.length} detected AI agent(s).`);
      selected = detected;
    }

    targetPaths = new Set(selected.map((c) => c.foundPath));
  }

  // --- Process each config file ---
  let modifiedCount = 0;

  for (const config of configs) {
    for (const configPath of config.paths) {
      if (!targetPaths.has(configPath)) {
        continue;
      }
      if (!fs.existsSync(configPath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(configPath, 'utf8');
        let parsed: any;
        try {
          parsed = parseJsonc(content);
        } catch {
          // File might be empty or invalid JSON, skip it
          continue;
        }

        if (!parsed) {
          continue;
        }

        const serversKey = getServersKeyForConfig(config.name, configPath, parsed);
        let servers = parsed[serversKey];
        let fileChanged = false;

        // Restore mode: try clean backup restore first if possible
        if (options.restore) {
          const backupPath = configPath + '.undomcp-backup';
          if (fs.existsSync(backupPath)) {
            try {
              const backupContent = fs.readFileSync(backupPath, 'utf8');
              const backupParsed = parseJsonc(backupContent);
              
              // Apply in-memory restoration to see if it results in the original backup state
              const testParsed = JSON.parse(JSON.stringify(parsed));
              const testServers = testParsed[serversKey];
              if (testServers && typeof testServers === 'object') {
                for (const name of Object.keys(testServers)) {
                  if (name === 'undomcp') {
                    delete testServers.undomcp;
                    continue;
                  }
                  const srv = testServers[name];
                  if (srv.__originalCommand) {
                    srv.command = srv.__originalCommand;
                    srv.args = srv.__originalArgs || [];
                    delete srv.__originalCommand;
                    delete srv.__originalArgs;
                  }
                }
              }
              if (serversKey === 'github.copilot.chat.mcp.servers') {
                if (backupParsed['github.copilot.chat.mcp.enabled'] !== undefined) {
                  testParsed['github.copilot.chat.mcp.enabled'] = backupParsed['github.copilot.chat.mcp.enabled'];
                } else {
                  delete testParsed['github.copilot.chat.mcp.enabled'];
                }
              }

              // If the in-memory restoration equals the original backup config, we restore the backup file directly.
              // This fully preserves comments, spacing, and formatting.
              if (deepEqual(testParsed, backupParsed)) {
                fs.copyFileSync(backupPath, configPath);
                fs.unlinkSync(backupPath);
                console.log(`[undomcp] Restored original config with comments from backup for ${config.name}`);
                modifiedCount++;
                continue;
              }
            } catch (err: any) {
              // fall back to default JSON serialization restore
            }
          }
        }

        if (!servers || typeof servers !== 'object') {
          if (!options.restore) {
            parsed[serversKey] = {};
            servers = parsed[serversKey];
            fileChanged = true;
          } else {
            continue;
          }
        }

        if (serversKey === 'github.copilot.chat.mcp.servers') {
          if (!options.restore && parsed['github.copilot.chat.mcp.enabled'] !== true) {
            parsed['github.copilot.chat.mcp.enabled'] = true;
            fileChanged = true;
          }
        }

        for (const name of Object.keys(servers)) {
          if (name === 'undomcp') continue;

          const srv = servers[name];
          if (options.restore) {
            // Restore original server config if it was wrapped
            if (srv.__originalCommand) {
              srv.command = srv.__originalCommand;
              srv.args = srv.__originalArgs || [];
              delete srv.__originalCommand;
              delete srv.__originalArgs;
              fileChanged = true;
            }
          } else {
            // Wrap server if not already wrapped
            const isWrapped = srv.command === undomcpBin ||
                              (typeof srv.command === 'string' && srv.command.endsWith('undomcp')) ||
                              (typeof srv.command === 'string' && srv.command.endsWith('undomcp.exe')) ||
                              (srv.command && (srv.command.endsWith('node') || srv.command.endsWith('node.exe')) && Array.isArray(srv.args) && srv.args.includes(undomcpBin));

            if (!isWrapped && srv.command) {
              // Create backup before first modification
              if (!fileChanged) {
                const backupPath = backupConfigFile(configPath);
                if (backupPath) {
                  console.log(`[undomcp] Backup created: ${shortenPath(backupPath)}`);
                }
              }

              srv.__originalCommand = srv.command;
              srv.__originalArgs = srv.args || [];

              const runWithNode = undomcpBin.endsWith('.js') || undomcpBin.endsWith('.ts');
              if (runWithNode) {
                srv.command = process.execPath;
                srv.args = [undomcpBin, 'serve', '--command', srv.__originalCommand, '--args', ...(srv.__originalArgs || [])];
              } else {
                srv.command = undomcpBin;
                srv.args = ['serve', '--command', srv.__originalCommand, '--args', ...(srv.__originalArgs || [])];
              }
              fileChanged = true;
            }
          }
        }

        // Handle standalone undomcp registration
        if (!options.restore) {
          const hasUndomcp = !!servers.undomcp;
          if (!hasUndomcp) {
            if (!fileChanged) {
              const backupPath = backupConfigFile(configPath);
              if (backupPath) {
                console.log(`[undomcp] Backup created: ${shortenPath(backupPath)}`);
              }
            }
            const runWithNode = undomcpBin.endsWith('.js') || undomcpBin.endsWith('.ts');
            if (runWithNode) {
              servers.undomcp = {
                command: process.execPath,
                args: [undomcpBin, 'serve', '--command', 'node', '--args', '-e', '""']
              };
            } else {
              servers.undomcp = {
                command: undomcpBin,
                args: ['serve', '--command', 'node', '--args', '-e', '""']
              };
            }
            fileChanged = true;
          }
        } else {
          // Restore mode: remove undomcp standalone server only if it matches our added version
          if (servers.undomcp) {
            const matchesCommand = servers.undomcp.command === undomcpBin || 
                                   (servers.undomcp.command && (servers.undomcp.command.endsWith('node') || servers.undomcp.command.endsWith('node.exe')) && Array.isArray(servers.undomcp.args) && servers.undomcp.args.includes(undomcpBin)) ||
                                   (typeof servers.undomcp.command === 'string' && servers.undomcp.command.endsWith('undomcp')) ||
                                   (typeof servers.undomcp.command === 'string' && servers.undomcp.command.endsWith('undomcp.exe'));
            if (matchesCommand) {
              delete servers.undomcp;
              fileChanged = true;
            }
          }
        }

        if (fileChanged) {
          fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
          console.log(`[undomcp] Successfully ${options.restore ? 'restored' : 'configured'} ${config.name} at: ${shortenPath(configPath)}`);
          modifiedCount++;
        }
      } catch (err: any) {
        console.error(`[undomcp] Error processing ${config.name} config at ${configPath}: ${err.message}`);
      }
    }
  }

  if (!options.restore) {
    installAdapterSkills();
    if (modifiedCount === 0) {
      console.log('[undomcp] No configuration files were updated (already configured).');
    } else {
      console.log(`\n\x1b[32m✔ Setup complete! ${modifiedCount} IDE(s) configured.\x1b[0m`);
      console.log('\x1b[2mRun "undomcp setup --restore" to undo these configuration changes.\x1b[0m');
    }
  } else {
    removeAdapterSkills();
    console.log(`\n\x1b[32m✔ Restore complete! ${modifiedCount} IDE(s) restored to original configuration.\x1b[0m`);
  }
}

function getSkillsHomeDir(): string {
  if (overrideClientConfigs && overrideClientConfigs.length > 0) {
    return path.dirname(overrideClientConfigs[0].paths[0]);
  }
  return os.homedir();
}

function getWorkspaceDir(): string {
  if (overrideClientConfigs && overrideClientConfigs.length > 0) {
    return path.dirname(overrideClientConfigs[0].paths[0]);
  }
  return process.cwd();
}

function installAdapterSkills(): void {
  const home = getSkillsHomeDir();
  const cwd = getWorkspaceDir();

  const skillContent = `---
name: undomcp
description: Revert recent MCP tool calls and changes in order
---

# UndoMCP Skill

This skill allows you to view and undo recent MCP tool calls made in this project.

## Instructions

When the user invokes this skill (e.g., via /undomcp, by asking to undo/revert, or by saying "search <description>"):

### Step 0 — Search History (If requested)
If the user specifies a search query/description (e.g., "search deleting a table in a database") or asks to search:
1. Call the \\\`undomcp_search_history\\\` tool with the query.
2. If the tool returns \\\`found: false\\\`, tell the user: "Change not found." and stop.
3. If the tool returns \\\`found: true\\\`:
   a. Present the matched change in detail: its tool name, a clear description of what it did, its parameters, and result data.
   b. Present any dependent actions that were found (if any), explaining why they depend on this action.
   c. List any alternative matches returned by the tool (if any) as "Alternative Matches".
   d. Ask the user: "Do you want to proceed with undoing this change? (undoing this change will also undo any dependent changes)"
   e. If the user confirms to proceed, go to Step 3 using the matched action ID (and any dependent action IDs).

### Step 1 — Retrieve & Display Changes
1. Call the \\\`undomcp_list_history\\\` tool. It returns a JSON array of ALL recent MCP
   tool calls made in this project (across all sessions, even after IDE restarts).
   The array is ordered oldest-first (index 0 = oldest, last index = newest).
   Each entry includes a \\\`depends_on\\\` array showing structural dependencies
   between actions (shared resource IDs, confidence levels).
2. **Filter the results:** Only show actions that are **state-changing and reversible**.
   - **INCLUDE** (mutating): tools that create, update, patch, delete, move, post
     (e.g., \\\`API-post-page\\\`, \\\`API-patch-page\\\`, \\\`API-delete-a-block\\\`,
     \\\`createDocument\\\`, \\\`updateRecord\\\`).
   - **EXCLUDE** (read-only): tools that only read/fetch data like get, retrieve,
     list, search, query, read, fetch, find, lookup, describe, check, view, show,
     info, status, count (e.g., \\\`API-get-self\\\`, \\\`API-post-search\\\`,
     \\\`API-retrieve-a-page\\\`, \\\`API-get-block-children\\\`, \\\`API-query-data-source\\\`).
   Use your judgement to classify each tool based on its name and parameters.
3. **Pre-calculate the total count (N):** Before outputting the list, count the total number of filtered items (N). You MUST state this count in your thinking block.
4. Number **only the filtered items**. **Numbering rules:**
   - **#1 is always the most recent change** and appears at the **BOTTOM** of the list.
   - The **highest number** (oldest change) appears at the **TOP**.
   - Numbers **decrease** going down the list.
   - Example with 3 items: display as 3, 2, 1 from top to bottom.
   Each line MUST follow this exact format:
   \\\`\\\`\\\`
   N) namespace__tool_name - One sentence describing what this call did
   \\\`\\\`\\\`
   Write the one-line description yourself by analyzing the tool name, its input
   parameters, and its result data. Be specific and descriptive (e.g., "Created a
   new Notion page titled 'Meeting Notes'" not "Called a tool").
5. If no reversible changes exist, tell the user: "No undoable changes found."
6. Do NOT add headers, commentary, or extra text around the list. Only the numbered
   entries.

### Step 2 — Ask the User
After presenting the list, ask:
> "Which change do you want to undo?"
> - Say **\\\`undo #N\\\`** to undo just that one specific change.
> - Say **\\\`undo till #N\\\`** to undo changes #1 through #N (inclusive). Everything older than #N is kept.
> - Say **\\\`search <description>\\\`** to search the project history for a specific past change.

If the user references a change number that does not exist in the list, tell them
the valid range. For example: "Valid range is #1 to #5. Please pick a number in
that range."

### Step 3 — Build & Present Plan
Based on the user's choice (or search confirmation), build an undo plan:

**Determine which changes to undo:**
- **\\\`undo #N\\\`**: Only change #N. However, you MUST check: do any of the other
  changes (those more recent than #N) depend on the output or side effects of #N?
  If yes, warn the user clearly before proceeding:
  > "Warning: Change #M depends on #N (it references the resource created by #N).
  > If you undo #N without also undoing #M, change #M will break. Do you also want
  > to undo #M?"
  Let the user decide whether to include the dependent changes.
- **\\\`undo till #N\\\`**: Changes #1, #2, #3, ... #N (inclusive). Everything numbered higher than #N is kept.

**Classify each change to be undone — YOU must reason about the inverse:**
For each action, inspect its \\\`toolName\\\`, \\\`parameters\\\`, and \\\`resultData\\\` from the
history entry. The \\\`resultData\\\` often contains an MCP content wrapper like:
\\\`{ "content": [{ "type": "text", "text": "{...}" }] }\\\`
— you MUST parse the stringified JSON inside \\\`content[0].text\\\` to extract
resource IDs, page IDs, object types, etc.

Then check what MCP tools are available to you and determine:
- **Auto-reversible**: You can call an available MCP tool to reverse this action.
  Examples:
  - \\\`API-post-page\\\` (page created) → call \\\`API-patch-page\\\` with the created
    page's ID and \\\`{ "in_trash": true }\\\` to trash it.
  - \\\`API-patch-page\\\` (page updated) → call \\\`API-patch-page\\\` with the original
    property values to restore them.
  - \\\`createDocument\\\` → call \\\`deleteDocument\\\` with the created document's ID.
- **Manual-only**: No viable inverse MCP tool exists, or the reverse action could
  be harmful or irreversible.

**Present the plan as a numbered list showing each change, its classification, and what will happen. Include any dependency warnings.**

Ask the user: **"Do you want to proceed with this plan? (yes/no)"**

Do NOT execute anything until the user explicitly says yes.

### Step 4 — Execute Undo
After the user approves, execute each undo **in reverse chronological order**
(most recent first):

1. **For each auto-reversible action:**
   a. Call the inverse MCP tool directly yourself (e.g., call \\\`API-patch-page\\\`
      with \\\`{ "page_id": "...", "in_trash": true }\\\`). You have access to all MCP
      tools — use them.
   b. After the inverse call succeeds, call \\\`undomcp_undo_action\\\` with that
      action's ID to mark it as undone in the journal.
   c. Report the result to the user.

2. **For file-change actions:** Call \\\`undomcp_undo_action\\\` with the action ID.
   The tool handles file snapshot restoration automatically.

3. **For manual-only actions:** Skip the inverse call. Still call
   \\\`undomcp_undo_action\\\` to mark it as acknowledged, then provide manual
   instructions in the summary.

### Step 5 — Summary & Manual Guide
After all undos are complete:

1. Show a success summary listing each change that was successfully undone.

2. If ANY changes were classified as manual-only, present a clear
   **"Manual Undo Guide"** section organized by application. Use actual resource
   names, IDs, and content from the original call parameters and results. Be
   specific enough that the user can follow the steps without guessing.
`;

  const mdcContent = `---
description: Revert recent MCP tool calls and changes in order
globs: *
alwaysApply: true
---

# UndoMCP Rules
When the user asks to "undo", "revert", "rollback", "open undomcp", or search for a past change (e.g. "search <description>"):

**IMPORTANT — Do NOT improvise:** If the \\\`undomcp_list_history\\\` tool is not available,
not found, or the call returns an error, tell the user:
"The undomcp_list_history tool is not available or returned an error.
Please ensure undomcp is properly configured by running \\\`undomcp setup\\\`."
Do NOT attempt to query the database manually, write scripts, search for database
files, or work around the problem in any way. Stop immediately and report the error.

### Step 0 — Search History (If requested)
If the user specifies a search query/description (e.g., "search deleting a table in a database") or asks to search:
1. Call the \\\`undomcp_search_history\\\` tool with the query.
2. If the tool returns \\\`found: false\\\`, tell the user: "Change not found." and stop.
3. If the tool returns \\\`found: true\\\`:
   a. Present the matched change in detail: tool name, description of what it did, parameters, and result data.
   b. Present any dependent actions that were found (if any), explaining why they depend on this action.
   c. List any alternative matches returned by the tool (if any) as "Alternative Matches".
   d. Ask the user: "Do you want to proceed with undoing this change? (undoing this change will also undo any dependent changes)"
   e. If the user confirms to proceed, go to Step 3 using the matched action ID (and any dependent action IDs).

### Step 1 — Retrieve & Display Changes
1. Call the \\\`undomcp_list_history\\\` tool. It returns a JSON array of ALL recent MCP
   tool calls made in this project (across all sessions, even after IDE restarts).
   The array is ordered oldest-first (index 0 = oldest, last index = newest).
   Each entry includes a \\\`depends_on\\\` array showing structural dependencies.
2. **Filter the results:** Only show actions that are **state-changing and reversible**.
   - **INCLUDE** (mutating): tools that create, update, patch, delete, move, post.
   - **EXCLUDE** (read-only): tools that get, retrieve, list, search, query, read,
     fetch, find, lookup, describe, check, view, show (e.g., \\\`API-get-self\\\`,
     \\\`API-post-search\\\`, \\\`API-retrieve-a-page\\\`).
   Use your judgement to classify each tool based on its name and parameters.
3. **Pre-calculate the total count (N):** Before outputting the list, count the total number of filtered items (N). You MUST state this count in your thinking block.
4. Number **only the filtered items**. **Numbering rules:**
   - **#1 is always the most recent change** and appears at the **BOTTOM**.
   - The **highest number** (oldest change) appears at the **TOP**.
   - Numbers **decrease** going down the list.
   Each line: \\\`N) namespace__tool_name - One sentence describing what this call did\\\`
   Write the description by analyzing the tool name, parameters, and result data.
5. If no reversible changes exist, tell the user: "No undoable changes found."
6. Do NOT add headers, commentary, or extra text around the list.

### Step 2 — Ask the User
After presenting the list, ask:
> "Which change do you want to undo?"
> - Say **\\\`undo #N\\\`** to undo just that one specific change.
> - Say **\\\`undo till #N\\\`** to undo changes #1 through #N (inclusive). Everything older than #N is kept.
> - Say **\\\`search <description>\\\`** to search the project history for a specific past change.

If the user references a change number that does not exist in the list, tell them
the valid range. For example: "Valid range is #1 to #5. Please pick a number in
that range."

### Step 3 — Build & Present Plan
Based on the user's choice (or search confirmation), build an undo plan:
- **\\\`undo #N\\\`**: Only change #N. Check if any more recent changes depend on #N's
  output. If yes, warn the user and ask if they want to also undo those.
- **\\\`undo till #N\\\`**: Changes #1, #2, #3, ... #N (inclusive). Everything numbered higher than #N is kept.

For each change, YOU must reason about the inverse by inspecting \\\`toolName\\\`,
\\\`parameters\\\`, and \\\`resultData\\\`. Parse stringified JSON in \\\`resultData.content[0].text\\\`
to extract resource IDs. Classify as:
- **Auto-reversible**: You can call an available MCP tool to reverse this action.
- **Manual-only**: No viable inverse exists or reversal could be harmful.

Present the plan with classifications and dependency warnings. Ask the user to
confirm before executing.

### Step 4 — Execute Undo
After approval, execute in reverse chronological order:
1. **Auto-reversible**: Call the inverse MCP tool directly yourself, then call
   \\\`undomcp_undo_action\\\` to mark it as undone in the journal.
2. **File-change actions**: Call \\\`undomcp_undo_action\\\` (handles snapshot restore).
3. **Manual-only**: Call \\\`undomcp_undo_action\\\` to mark as acknowledged, provide
   manual instructions in summary.

### Step 5 — Summary & Manual Guide
Show a success summary. If any changes were manual-only, present a "Manual Undo
Guide" organized by application with specific step-by-step instructions using
actual resource names and IDs from the original call data.
`;

  const textRulesContent = `# UndoMCP Rules
When the user asks to "undo", "revert", "rollback", "open undomcp", or search for a past change (e.g. "search <description>"):

**IMPORTANT — Do NOT improvise:** If the \\\`undomcp_list_history\\\` tool is not available,
not found, or the call returns an error, tell the user:
"The undomcp_list_history tool is not available or returned an error.
Please ensure undomcp is properly configured by running \\\`undomcp setup\\\`."
Do NOT attempt to query the database manually, write scripts, search for database
files, or work around the problem in any way. Stop immediately and report the error.

### Step 0 — Search History (If requested)
If the user specifies a search query/description (e.g., "search deleting a table in a database") or asks to search:
1. Call the \\\`undomcp_search_history\\\` tool with the query.
2. If the tool returns \\\`found: false\\\`, tell the user: "Change not found." and stop.
3. If the tool returns \\\`found: true\\\`:
   a. Present the matched change in detail: tool name, description of what it did, parameters, and result data.
   b. Present any dependent actions that were found (if any), explaining why they depend on this action.
   c. List any alternative matches returned by the tool (if any) as "Alternative Matches".
   d. Ask the user: "Do you want to proceed with undoing this change? (undoing this change will also undo any dependent changes)"
   e. If the user confirms to proceed, go to Step 3 using the matched action ID (and any dependent action IDs).

### Step 1 — Retrieve & Display Changes
1. Call the \\\`undomcp_list_history\\\` tool. It returns a JSON array of ALL recent MCP
   tool calls made in this project (across all sessions, even after IDE restarts).
   The array is ordered oldest-first (index 0 = oldest, last index = newest).
2. **Filter the results:** Only show actions that are **state-changing and reversible**.
   - **INCLUDE** (mutating): tools that create, update, patch, delete, move, post.
   - **EXCLUDE** (read-only): tools that get, retrieve, list, search, query, read,
     fetch, find, lookup, describe, check, view, show (e.g., \\\`API-get-self\\\`,
     \\\`API-post-search\\\`, \\\`API-retrieve-a-page\\\`).
   Use your judgement to classify each tool based on its name and parameters.
3. **Pre-calculate the total count (N):** Before outputting the list, count the total number of filtered items (N). You MUST state this count in your thinking block.
4. Number **only the filtered items**. **Numbering rules:**
   - **#1 is always the most recent change** and appears at the **BOTTOM**.
   - The **highest number** (oldest change) appears at the **TOP**.
   - Numbers **decrease** going down the list.
   Each line: \\\`N) namespace__tool_name - One sentence describing what this call did\\\`
   Write the description by analyzing the tool name, parameters, and result data.
5. If no reversible changes exist, tell the user: "No undoable changes found."
6. Do NOT add headers, commentary, or extra text around the list.

### Step 2 — Ask the User
After presenting the list, ask:
> "Which change do you want to undo?"
> - Say **\\\`undo #N\\\`** to undo just that one specific change.
> - Say **\\\`undo till #N\\\`** to undo changes #1 through #N (inclusive). Everything older than #N is kept.
> - Say **\\\`search <description>\\\`** to search the project history for a specific past change.

If the user references a change number that does not exist in the list, tell them
the valid range. For example: "Valid range is #1 to #5. Please pick a number in
that range."

### Step 3 — Build & Present Plan
Based on the user's choice (or search confirmation), build an undo plan:
- **\\\`undo #N\\\`**: Only change #N. Check if any more recent changes depend on #N's
  output. If yes, warn the user and ask if they want to also undo those.
- **\\\`undo till #N\\\`**: Changes #1, #2, #3, ... #N (inclusive). Everything numbered higher than #N is kept.

For each change, YOU must reason about the inverse by inspecting \\\`toolName\\\`,
\\\`parameters\\\`, and \\\`resultData\\\`. Parse stringified JSON in \\\`resultData.content[0].text\\\`
to extract resource IDs. Classify as:
- **Auto-reversible**: You can call an available MCP tool to reverse this action.
- **Manual-only**: No viable inverse exists or reversal could be harmful.

Present the plan with classifications and dependency warnings. Ask the user to
confirm before executing.

### Step 4 — Execute Undo
After approval, execute in reverse chronological order:
1. **Auto-reversible**: Call the inverse MCP tool directly yourself, then call
   \`undomcp_undo_action\` to mark it as undone in the journal.
2. **File-change actions**: Call \`undomcp_undo_action\` (handles snapshot restore).
3. **Manual-only**: Call \`undomcp_undo_action\` to mark as acknowledged, provide
   manual instructions in summary.

### Step 5 — Summary & Manual Guide
Show a success summary. If any changes were manual-only, present a "Manual Undo
Guide" organized by application with specific step-by-step instructions using
actual resource names and IDs from the original call data.
`;

  // 1. Claude Code Global Skill
  const claudeSkillsDir = path.join(home, '.claude/skills/undomcp');
  try {
    fs.mkdirSync(claudeSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(claudeSkillsDir, 'SKILL.md'), skillContent, 'utf8');
    console.log(`[undomcp] Installed Claude Code global skill at: ${shortenPath(path.join(claudeSkillsDir, 'SKILL.md'))}`);
  } catch (err: any) {
    console.error(`[undomcp] Failed to install Claude Code skill: ${err.message}`);
  }

  // 2. Gemini / Antigravity Global Skill
  const geminiSkillsDir = path.join(home, '.gemini/config/skills/undomcp');
  try {
    fs.mkdirSync(geminiSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(geminiSkillsDir, 'SKILL.md'), skillContent, 'utf8');
    console.log(`[undomcp] Installed Gemini/Antigravity global skill at: ${shortenPath(path.join(geminiSkillsDir, 'SKILL.md'))}`);
  } catch (err: any) {
    console.error(`[undomcp] Failed to install Gemini skill: ${err.message}`);
  }

  // 3. Windsurf Global Rules
  const windsurfMemoriesDir = path.join(home, '.codeium/windsurf/memories');
  try {
    fs.mkdirSync(windsurfMemoriesDir, { recursive: true });
    fs.writeFileSync(path.join(windsurfMemoriesDir, 'global_rules.md'), textRulesContent, 'utf8');
    console.log(`[undomcp] Installed Windsurf global rules at: ${shortenPath(path.join(windsurfMemoriesDir, 'global_rules.md'))}`);
  } catch (err: any) {
    console.error(`[undomcp] Failed to install Windsurf global rules: ${err.message}`);
  }

  // 4. Local Workspace rules (Cursor & Windsurf)
  const cursorRulesDir = path.join(cwd, '.cursor/rules');
  const windsurfRulesDir = path.join(cwd, '.windsurf/rules');

  // Write to .cursorrules at root
  try {
    fs.writeFileSync(path.join(cwd, '.cursorrules'), textRulesContent, 'utf8');
    console.log(`[undomcp] Installed local .cursorrules in current workspace`);
  } catch {}

  // Write to .cursor/rules/undomcp.mdc
  try {
    fs.mkdirSync(cursorRulesDir, { recursive: true });
    fs.writeFileSync(path.join(cursorRulesDir, 'undomcp.mdc'), mdcContent, 'utf8');
    console.log(`[undomcp] Installed local .cursor/rules/undomcp.mdc in current workspace`);
  } catch {}

  // Write to .windsurfrules at root
  try {
    fs.writeFileSync(path.join(cwd, '.windsurfrules'), textRulesContent, 'utf8');
    console.log(`[undomcp] Installed local .windsurfrules in current workspace`);
  } catch {}

  // Write to .windsurf/rules/undomcp.md
  try {
    fs.mkdirSync(windsurfRulesDir, { recursive: true });
    fs.writeFileSync(path.join(windsurfRulesDir, 'undomcp.md'), textRulesContent, 'utf8');
    console.log(`[undomcp] Installed local .windsurf/rules/undomcp.md in current workspace`);
  } catch {}
}

function removeAdapterSkills(): void {
  const home = getSkillsHomeDir();
  const cwd = getWorkspaceDir();
  const claudeSkillsDir = path.join(home, '.claude/skills/undomcp');
  const geminiSkillsDir = path.join(home, '.gemini/config/skills/undomcp');
  const windsurfGlobalRules = path.join(home, '.codeium/windsurf/memories/global_rules.md');

  try {
    if (fs.existsSync(claudeSkillsDir)) {
      fs.rmSync(claudeSkillsDir, { recursive: true, force: true });
      console.log(`[undomcp] Removed Claude Code global skill.`);
    }
  } catch {}

  try {
    if (fs.existsSync(geminiSkillsDir)) {
      fs.rmSync(geminiSkillsDir, { recursive: true, force: true });
      console.log(`[undomcp] Removed Gemini/Antigravity global skill.`);
    }
  } catch {}

  try {
    if (fs.existsSync(windsurfGlobalRules)) {
      fs.unlinkSync(windsurfGlobalRules);
      console.log(`[undomcp] Removed Windsurf global rules.`);
    }
  } catch {}

  // Clean up workspace files
  try {
    const filesToUnlink = [
      path.join(cwd, '.cursorrules'),
      path.join(cwd, '.cursor/rules/undomcp.mdc'),
      path.join(cwd, '.windsurfrules'),
      path.join(cwd, '.windsurf/rules/undomcp.md')
    ];
    for (const file of filesToUnlink) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
    // Clean up empty directories if possible
    if (fs.existsSync(path.join(cwd, '.cursor/rules')) && fs.readdirSync(path.join(cwd, '.cursor/rules')).length === 0) {
      fs.rmdirSync(path.join(cwd, '.cursor/rules'));
    }
    if (fs.existsSync(path.join(cwd, '.cursor')) && fs.readdirSync(path.join(cwd, '.cursor')).length === 0) {
      fs.rmdirSync(path.join(cwd, '.cursor'));
    }
    if (fs.existsSync(path.join(cwd, '.windsurf/rules')) && fs.readdirSync(path.join(cwd, '.windsurf/rules')).length === 0) {
      fs.rmdirSync(path.join(cwd, '.windsurf/rules'));
    }
    if (fs.existsSync(path.join(cwd, '.windsurf')) && fs.readdirSync(path.join(cwd, '.windsurf')).length === 0) {
      fs.rmdirSync(path.join(cwd, '.windsurf'));
    }
    console.log(`[undomcp] Cleaned up workspace rules.`);
  } catch {}
}
