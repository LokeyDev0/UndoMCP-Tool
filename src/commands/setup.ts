import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
      name: 'Windsurf',
      paths: [
        path.join(home, '.codeium/windsurf/mcp_config.json')
      ]
    }
  ];
}

export async function runSetup(options: { restore?: boolean; binaryPath?: string }): Promise<void> {
  const configs = getClientConfigs();
  
  // Detect if running from compiled binary or raw node
  const isCompiled = !process.argv[1] || !process.argv[1].endsWith('.js');
  const undomcpBin = options.binaryPath || (isCompiled ? process.argv[0] : 'undomcp');

  let modifiedCount = 0;

  for (const config of configs) {
    for (const configPath of config.paths) {
      if (!fs.existsSync(configPath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(configPath, 'utf8');
        let parsed: any;
        try {
          parsed = JSON.parse(content);
        } catch {
          // File might be empty or invalid JSON, skip it
          continue;
        }

        if (!parsed || typeof parsed.mcpServers !== 'object') {
          continue;
        }

        const servers = parsed.mcpServers;
        let fileChanged = false;

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
                              (typeof srv.command === 'string' && srv.command.endsWith('undomcp.exe'));

            if (!isWrapped && srv.command) {
              srv.__originalCommand = srv.command;
              srv.__originalArgs = srv.args || [];
              
              srv.command = undomcpBin;
              srv.args = ['serve', '--command', srv.__originalCommand, '--args', ...(srv.__originalArgs || [])];
              fileChanged = true;
            }
          }
        }

        if (fileChanged) {
          fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
          console.log(`[undomcp] Successfully ${options.restore ? 'restored' : 'configured'} ${config.name} at: ${configPath}`);
          modifiedCount++;
        }
      } catch (err: any) {
        console.error(`[undomcp] Error processing ${config.name} config at ${configPath}: ${err.message}`);
      }
    }
  }

  if (modifiedCount === 0) {
    console.log('[undomcp] No configuration files were updated.');
  }
}
