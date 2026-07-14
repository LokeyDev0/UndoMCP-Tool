import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { runSetup } from './setup.js';

export interface UninstallOptions {
  keepDb?: boolean;
  full?: boolean;
}

type UninstallMode = 'soft' | 'full';

/**
 * Interactive TUI to let the user choose between soft and full uninstall.
 * Returns 'soft', 'full', or null if cancelled.
 */
async function selectUninstallMode(): Promise<UninstallMode | null> {
  return new Promise((resolve) => {
    const options = [
      {
        label: 'Soft Uninstall',
        description: 'Remove MCP server configs and skill files from all IDEs, but keep the journal database.',
        detail: 'You can re-enable undomcp later with just `undomcp setup` — your history is preserved.',
      },
      {
        label: 'Full Uninstall',
        description: 'Wipe everything: MCP configs, skill files, AND the journal database.',
        detail: 'Completely removes all traces. Requires `undomcp setup` to start fresh.',
      },
    ];

    let cursorIndex = 0;
    let lastRenderedLines = 0;

    function moveCursorUp(lines: number) {
      if (lines > 0) {
        process.stdout.write(`\x1b[${lines}A`);
      }
    }

    function render() {
      if (lastRenderedLines > 0) {
        moveCursorUp(lastRenderedLines);
        process.stdout.write('\x1b[J');
      }

      const lines: string[] = [];
      lines.push('');
      lines.push('\x1b[1m\x1b[36m╔══════════════════════════════════════════════════╗\x1b[0m');
      lines.push('\x1b[1m\x1b[36m║          UndoMCP — Uninstall Options             ║\x1b[0m');
      lines.push('\x1b[1m\x1b[36m╚══════════════════════════════════════════════════╝\x1b[0m');
      lines.push('');
      lines.push('  Choose how you want to uninstall:');
      lines.push('  \x1b[2m(Use ↑/↓ to navigate, Enter to confirm, q to cancel)\x1b[0m');
      lines.push('');

      options.forEach((opt, index) => {
        const isSelected = cursorIndex === index;
        const pointer = isSelected ? '\x1b[36m➔\x1b[0m ' : '  ';
        const radio = isSelected ? '\x1b[32m(●)\x1b[0m' : '( )';
        const nameStyle = isSelected ? '\x1b[1m\x1b[36m' : '\x1b[1m';

        lines.push(`  ${pointer}${radio} ${nameStyle}${opt.label}\x1b[0m`);
        lines.push(`       \x1b[2m${opt.description}\x1b[0m`);
        lines.push(`       \x1b[2m${opt.detail}\x1b[0m`);
        if (index < options.length - 1) {
          lines.push('');
        }
      });

      lines.push('');

      const output = lines.join('\n') + '\n';
      process.stdout.write(output);
      lastRenderedLines = output.split('\n').length - 1;
    }

    const onKeypress = (_str: string, key: any) => {
      if (!key) return;

      if ((key.ctrl && key.name === 'c') || key.name === 'q') {
        cleanup();
        console.log('\n\x1b[33mUninstall cancelled.\x1b[0m');
        resolve(null);
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        cursorIndex = (cursorIndex - 1 + options.length) % options.length;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        cursorIndex = (cursorIndex + 1) % options.length;
        render();
      } else if (key.name === 'return') {
        cleanup();
        const mode: UninstallMode = cursorIndex === 0 ? 'soft' : 'full';
        const chosen = options[cursorIndex];
        console.log(`\n\x1b[32m✔ Selected: ${chosen.label}\x1b[0m\n`);
        resolve(mode);
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

export async function runUninstall(options: UninstallOptions): Promise<void> {
  // Determine mode: explicit flags take priority, otherwise show interactive prompt
  let mode: UninstallMode;

  if (options.keepDb) {
    mode = 'soft';
  } else if (options.full) {
    mode = 'full';
  } else if (process.stdin.isTTY) {
    // Interactive: show the selection TUI
    const selected = await selectUninstallMode();
    if (!selected) {
      return; // User cancelled
    }
    mode = selected;
  } else {
    // Non-interactive without flags: default to soft (safe choice)
    console.log('[undomcp] Non-interactive mode detected. Defaulting to soft uninstall (use --full for complete removal).\n');
    mode = 'soft';
  }

  const deleteDb = mode === 'full';

  console.log(`[undomcp] Starting ${mode === 'full' ? 'full' : 'soft'} uninstall...\n`);

  // Step 1: Restore all MCP configurations (unwrap proxied servers, remove standalone entry, remove skill files)
  console.log('[undomcp] Step 1: Restoring MCP configurations and removing skill files...');
  try {
    await runSetup({ restore: true, all: true });
  } catch (err: any) {
    console.error(`[undomcp] Warning: Error during config restore: ${err.message}`);
  }

  // Step 2: Handle journal database
  const home = os.homedir();
  const undomcpDataDir = path.join(home, '.undomcp');

  if (deleteDb) {
    console.log('\n[undomcp] Step 2: Removing journal database...');
    if (fs.existsSync(undomcpDataDir)) {
      try {
        fs.rmSync(undomcpDataDir, { recursive: true, force: true });
        console.log(`[undomcp] Deleted ${undomcpDataDir}`);
      } catch (err: any) {
        console.error(`[undomcp] Warning: Could not delete ${undomcpDataDir}: ${err.message}`);
        console.log('[undomcp] The database may be locked by a running undomcp process.');
        console.log('[undomcp] Close all IDEs and try again, or delete it manually.');
      }
    } else {
      console.log('[undomcp] No journal database found (already clean).');
    }
  } else {
    console.log('\n[undomcp] Step 2: Keeping journal database (soft uninstall).');
    console.log(`[undomcp] Database preserved at: ${undomcpDataDir}`);
  }

  // Step 3: Print summary and npm uninstall instruction
  console.log('\n' + '─'.repeat(60));
  console.log('\x1b[32m✔ Uninstall complete!\x1b[0m\n');
  console.log('The following have been cleaned up:');
  console.log('  ✓ MCP configurations restored to original state');
  console.log('  ✓ Skill and rule files removed from all IDEs');
  if (deleteDb) {
    console.log('  ✓ Journal database deleted');
  } else {
    console.log('  ⊘ Journal database preserved (soft uninstall)');
  }

  if (deleteDb) {
    console.log('\nTo complete removal, run:\n');
    console.log('  \x1b[36mnpm uninstall -g undomcp\x1b[0m\n');
    console.log('This will remove the undomcp binary from your system.');
    console.log('To reinstall later: npm install -g undomcp && undomcp setup');
  } else {
    console.log('\nTo re-enable undomcp, simply run:\n');
    console.log('  \x1b[36mundomcp setup\x1b[0m\n');
    console.log('Your history and journal data are intact.');
    console.log('\nTo fully remove undomcp from your system later, run:');
    console.log('  \x1b[36mundomcp uninstall --full\x1b[0m');
  }
}
