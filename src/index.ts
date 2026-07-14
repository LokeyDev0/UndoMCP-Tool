#!/usr/bin/env node
import { Command } from 'commander';
import { DatabaseManager } from './journal/database-manager.js';
import { ProxyEngine } from './proxy/engine.js';
import { handleListHistory } from './tools/undo-tools.js';
import { nanoid } from 'nanoid';

const program = new Command();

program
  .name('undomcp')
  .description('Universal AI Agent Undo Tool via MCP Proxy')
  .version('1.0.0');

// Serve subcommand
program
  .command('serve')
  .description('Start the undomcp JSON-RPC intercepting proxy server')
  .requiredOption('--command <cmd>', 'Downstream MCP server executable command')
  .option('--args <args...>', 'Arguments to pass to the downstream MCP server')
  .option('--session-id <id>', 'Session ID for journaling (generates automatically if omitted)')
  .option('--db <path>', 'Custom SQLite database path')
  .option('--idle-timeout <ms>', 'Idle turn clustering threshold in milliseconds', '180000')
  .action(async (options) => {
    const dbPath = options.db;
    const dbManager = new DatabaseManager(dbPath);
    const sessionId = options.sessionId || `sess_${nanoid()}`;

    // Determine working directory: prefer explicit env var over process.cwd()
    const workingDir = process.env.UNDOMCP_PROJECT_DIR || process.cwd();

    // Initialize session in database
    dbManager.createSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      workingDirectory: workingDir
    });

    const parsedArgs: string[] = [];
    if (options.args) {
      if (Array.isArray(options.args)) {
        parsedArgs.push(...options.args);
      } else {
        parsedArgs.push(...(options.args as string).split(/\s+/));
      }
    }

    const turnIdleTimeoutMs = Number(options.idleTimeout) || 180000;

    const proxy = new ProxyEngine({
      command: options.command,
      args: parsedArgs,
      dbManager,
      sessionId,
      turnIdleTimeoutMs
    });

    // Handle clean termination to close database and session
    const cleanup = () => {
      try {
        dbManager.endSession(sessionId, new Date().toISOString());
        dbManager.close();
      } catch (err: any) {
        console.error(`[undomcp] Error during session cleanup: ${err.message}`);
      }
    };

    process.on('SIGINT', () => {
      cleanup();
      proxy.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      cleanup();
      proxy.stop();
      process.exit(0);
    });

    proxy.start();
  });

// Setup subcommand
program
  .command('setup')
  .description('Configure AI agent clients to route tools through undomcp')
  .option('--restore', 'Restore original configuration prior to undomcp setup')
  .option('--binary-path <path>', 'Absolute path to the undomcp binary')
  .option('--all', 'Configure all detected IDEs without interactive selection')
  .action(async (options) => {
    const { runSetup } = await import('./commands/setup.js');
    await runSetup(options);
  });

// Uninstall subcommand
program
  .command('uninstall')
  .description('Remove undomcp from your system (interactive: choose soft or full uninstall)')
  .option('--keep-db', 'Soft uninstall: remove configs and skills but keep the journal database')
  .option('--full', 'Full uninstall: wipe everything including the journal database')
  .action(async (options) => {
    const { runUninstall } = await import('./commands/uninstall.js');
    await runUninstall(options);
  });

// Clear history subcommand
program
  .command('clearHistory')
  .description('Clear the journal database (delete all recorded MCP call history)')
  .action(async () => {
    const { runClearHistory } = await import('./commands/clear-history.js');
    await runClearHistory();
  });

// Handle default command (no arguments)
if (process.argv.length <= 2) {
  const dbManager = new DatabaseManager();
  try {
    const workingDir = process.cwd();
    const history = handleListHistory(dbManager, workingDir, 10);
    if (history.length > 0) {
      console.log(`Project: ${workingDir}`);
      console.log('\nRecent MCP Actions:');
      console.log(JSON.stringify(history, null, 2));
    } else {
      console.log('No MCP actions found for this project.');
    }
  } catch (err: any) {
    console.error(`[undomcp] Error reading journal: ${err.message}`);
  } finally {
    dbManager.close();
  }
} else {
  program.parse(process.argv);
}
