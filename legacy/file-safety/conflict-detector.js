import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { computeSha256 } from './snapshot-store.js';
/**
 * Checks if a file currently matches the expected hash.
 * Returns true if it matches, false if it differs or does not exist.
 */
export function verifyFileHash(filePath, expectedHash) {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
        return false;
    }
    try {
        const content = fs.readFileSync(absolutePath);
        const hash = computeSha256(content);
        return hash === expectedHash;
    }
    catch {
        return false;
    }
}
/**
 * Prompts the user to resolve a file conflict.
 * Option 1: Exit (abort rollback)
 * Option 2: Overwrite everything (revert to baseline snapshot)
 */
export async function resolveConflictPrompt(filePath, messageDetail) {
    return new Promise((resolve) => {
        const fileName = path.basename(filePath);
        // Determine console input/output stream
        let input = process.stdin;
        let output = process.stdout;
        let usingDevice = false;
        let ttyFd = null;
        // If stdin/stdout are redirected (e.g. in stdio MCP proxy mode),
        // attempt to open CON (Windows) or /dev/tty (Unix) directly.
        try {
            const isWindows = process.platform === 'win32';
            const device = isWindows ? 'CON' : '/dev/tty';
            ttyFd = fs.openSync(device, 'r+');
            input = fs.createReadStream('', { fd: ttyFd });
            output = fs.createWriteStream('', { fd: ttyFd });
            usingDevice = true;
        }
        catch (err) {
            // Direct console device not available, fallback to process standard streams
            input = process.stdin;
            output = process.stdout;
        }
        // Safety check for non-interactive environments (CI, background daemons) to prevent hangs
        const isInteractive = usingDevice || process.stdin.isTTY;
        if (!isInteractive) {
            console.warn(`[undomcp] Conflict in "${fileName}" but running in non-interactive environment. Defaulting to Exit.`);
            if (usingDevice && ttyFd !== null) {
                try {
                    fs.closeSync(ttyFd);
                }
                catch { }
            }
            resolve('exit');
            return;
        }
        const rl = readline.createInterface({
            input,
            output,
            terminal: true
        });
        const msg = `
[undomcp] EXTERNAL CHANGES DETECTED:
The file "${fileName}" was modified externally (by you or another AI agent) after it was logged.
Path: ${filePath}
${messageDetail ? `Details: ${messageDetail}\n` : ''}
What would you like to do?
  1. Exit (Abort rollback and keep current changes)
  2. Overwrite everything and get it to the stage where the user wants it (Revert it to exactly how it was in the prompt)

Select option (1 or 2): `;
        rl.question(msg, (answer) => {
            const trimmed = answer.trim();
            rl.close();
            if (usingDevice && ttyFd !== null) {
                try {
                    fs.closeSync(ttyFd);
                }
                catch {
                    // Ignore close error
                }
            }
            if (trimmed === '2' || trimmed.toLowerCase() === 'overwrite' || trimmed.toLowerCase() === '2') {
                resolve('overwrite');
            }
            else {
                resolve('exit');
            }
        });
    });
}
