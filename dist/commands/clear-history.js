import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
export async function runClearHistory() {
    const home = os.homedir();
    const dbPath = path.join(home, '.undomcp', 'journal.db');
    if (!fs.existsSync(dbPath)) {
        console.log('[undomcp] No journal database found. Nothing to clear.');
        return;
    }
    try {
        // Delete the database file and any WAL/SHM files
        const filesToDelete = [
            dbPath,
            dbPath + '-wal',
            dbPath + '-shm',
            dbPath + '-journal',
        ];
        for (const file of filesToDelete) {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        console.log('[undomcp] Journal database cleared successfully.');
        console.log(`[undomcp] Deleted: ${dbPath}`);
        console.log('[undomcp] A new database will be created on the next MCP call.');
    }
    catch (err) {
        console.error(`[undomcp] Error clearing database: ${err.message}`);
        console.log('[undomcp] The database may be locked by a running MCP server.');
        console.log('[undomcp] Close all IDEs and try again.');
    }
}
