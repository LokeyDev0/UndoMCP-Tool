#!/usr/bin/env node
import { Command } from 'commander';
import { DatabaseManager } from './journal/database-manager.js';
import { ProxyEngine } from './proxy/engine.js';
import { handleInteractive } from './tools/undo-tools.js';
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
    // Initialize session in database
    dbManager.createSession({
        id: sessionId,
        startedAt: new Date().toISOString(),
        workingDirectory: process.cwd()
    });
    const parsedArgs = [];
    if (options.args) {
        if (Array.isArray(options.args)) {
            // If commander parsed it as array (e.g. --args a b c or --args a --args b)
            parsedArgs.push(...options.args);
        }
        else {
            parsedArgs.push(...options.args.split(/\s+/));
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
        }
        catch (err) {
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
    .action(() => {
    console.log('[undomcp] Setup auto-discovery and proxy configuration will be fully implemented in Phase 6.');
    console.log('To run manually, configure your client to execute the undomcp binary:');
    console.log('  undomcp serve --command <original-mcp-server> --args "<args>"');
});
// Handle default command (no arguments)
if (process.argv.length <= 2) {
    const dbManager = new DatabaseManager();
    try {
        const latestSession = dbManager.getLatestSession();
        let isActive = false;
        if (latestSession && !latestSession.endedAt) {
            // Check if session started in the last 1 hour
            const oneHourAgo = Date.now() - 60 * 60 * 1000;
            const startTime = Date.parse(latestSession.startedAt);
            if (startTime > oneHourAgo) {
                isActive = true;
            }
        }
        if (isActive && latestSession) {
            console.log(`Active session found: ${latestSession.id}`);
            const checklist = handleInteractive(dbManager, latestSession.id);
            console.log('\n' + checklist);
        }
        else {
            console.log('No active session found. undomcp is active when run as a proxy inside an AI agent.');
        }
    }
    catch (err) {
        console.error(`[undomcp] Error reading journal: ${err.message}`);
    }
    finally {
        dbManager.close();
    }
}
else {
    program.parse(process.argv);
}
