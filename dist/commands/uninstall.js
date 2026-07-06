import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runSetup } from './setup.js';
export async function runUninstall(options) {
    console.log('[undomcp] Starting uninstall...\n');
    // Step 1: Restore all MCP configurations (unwrap proxied servers, remove standalone entry, remove skill files)
    console.log('[undomcp] Step 1: Restoring MCP configurations and removing skill files...');
    try {
        await runSetup({ restore: true, all: true });
    }
    catch (err) {
        console.error(`[undomcp] Warning: Error during config restore: ${err.message}`);
    }
    // Step 2: Delete journal database
    const home = os.homedir();
    const undomcpDataDir = path.join(home, '.undomcp');
    if (!options.keepDb) {
        console.log('\n[undomcp] Step 2: Removing journal database...');
        if (fs.existsSync(undomcpDataDir)) {
            try {
                fs.rmSync(undomcpDataDir, { recursive: true, force: true });
                console.log(`[undomcp] Deleted ${undomcpDataDir}`);
            }
            catch (err) {
                console.error(`[undomcp] Warning: Could not delete ${undomcpDataDir}: ${err.message}`);
                console.log('[undomcp] The database may be locked by a running undomcp process.');
                console.log('[undomcp] Close all IDEs and try again, or delete it manually.');
            }
        }
        else {
            console.log('[undomcp] No journal database found (already clean).');
        }
    }
    else {
        console.log('\n[undomcp] Step 2: Skipping database removal (--keep-db flag set).');
        console.log(`[undomcp] Database preserved at: ${undomcpDataDir}`);
    }
    // Step 3: Print summary and npm uninstall instruction
    console.log('\n' + '─'.repeat(60));
    console.log('\x1b[32m✔ Uninstall complete!\x1b[0m\n');
    console.log('The following have been cleaned up:');
    console.log('  ✓ MCP configurations restored to original state');
    console.log('  ✓ Skill and rule files removed from all IDEs');
    if (!options.keepDb) {
        console.log('  ✓ Journal database deleted');
    }
    else {
        console.log('  ⊘ Journal database preserved (--keep-db)');
    }
    console.log('\nTo complete removal, run:\n');
    console.log('  \x1b[36mnpm uninstall -g undomcp\x1b[0m\n');
    console.log('This will remove the undomcp binary from your system.');
    console.log('To reinstall later: npm install -g undomcp && undomcp setup');
}
