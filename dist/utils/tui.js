import * as readline from 'readline';
import { SnapshotStore } from '../file-safety/snapshot-store.js';
import { generateUnifiedDiff } from './diff.js';
export function runTui(dbManager, undoController, sessionId) {
    return new Promise((resolve, reject) => {
        // 1. Fetch turns and actions
        const turns = dbManager.getTurnsForSession(sessionId);
        const actions = dbManager.getActionsForSession(sessionId);
        if (turns.length === 0) {
            console.log('No turns logged in the current session yet.');
            resolve();
            return;
        }
        // 2. Build TuiItem list
        const items = [];
        const sortedTurns = [...turns].sort((a, b) => b.turnNum - a.turnNum);
        for (const turn of sortedTurns) {
            const turnActions = actions.filter((a) => a.turnId === turn.id);
            const allUndone = turnActions.length > 0 && turnActions.every((a) => a.state === 'undone');
            items.push({
                type: 'turn',
                id: turn.id,
                label: `Turn #${turn.turnNum}: ${turn.promptText || '(No prompt text)'}`,
                selected: false,
                indent: 0,
                turn,
                alreadyUndone: allUndone,
            });
            for (const action of turnActions) {
                items.push({
                    type: 'action',
                    id: action.id,
                    label: action.metadata?.label || `Call ${action.toolName || 'unknown tool'}`,
                    selected: false,
                    indent: 2,
                    action,
                    alreadyUndone: action.state === 'undone',
                });
            }
        }
        let cursorIndex = 0;
        let previewItem = null;
        let lastRenderedLines = 0;
        function moveCursorUp(lines) {
            if (lines > 0) {
                process.stdout.write(`\x1b[${lines}A`);
            }
        }
        function render() {
            // Clear previous rendering
            if (lastRenderedLines > 0) {
                moveCursorUp(lastRenderedLines);
                process.stdout.write('\x1b[J');
            }
            const lines = [];
            lines.push('=== UndoMCP Interactive Rollback TUI ===');
            lines.push('Use Up/Down (or j/k) to navigate, Space to toggle, Tab to preview, Enter to execute, Esc/q to exit.');
            lines.push('');
            items.forEach((item, index) => {
                const isHighlighted = index === cursorIndex;
                const indentStr = ' '.repeat(item.indent);
                let statusIcon = '[ ]';
                if (item.alreadyUndone) {
                    statusIcon = '✅ [Undone]';
                }
                else if (item.selected) {
                    statusIcon = '[x]';
                }
                const pointer = isHighlighted ? '\x1b[36m➔\x1b[0m ' : '  ';
                const textStyle = isHighlighted ? '\x1b[1m\x1b[36m' : '';
                const resetStyle = '\x1b[0m';
                lines.push(`${pointer}${indentStr}${statusIcon} ${textStyle}${item.label}${resetStyle}`);
            });
            lines.push('');
            if (previewItem) {
                lines.push('\x1b[1m--- Preview Panel (Press Tab again to close) ---\x1b[0m');
                const previewContent = getPreviewText(previewItem);
                lines.push(previewContent);
                lines.push('\x1b[1m------------------------------------------------\x1b[0m');
            }
            const output = lines.join('\n') + '\n';
            process.stdout.write(output);
            lastRenderedLines = output.split('\n').length - 1;
        }
        function getPreviewText(item) {
            if (item.type === 'turn') {
                const turn = item.turn;
                const turnActions = actions.filter((a) => a.turnId === turn.id);
                let preview = `Turn ID: ${turn.id}\n`;
                preview += `Prompt: "${turn.promptText || '(No prompt)'}"\n`;
                preview += `Timestamp: ${turn.timestamp}\n`;
                preview += `Actions:\n`;
                if (turnActions.length === 0) {
                    preview += `  No actions logged.`;
                }
                else {
                    turnActions.forEach((act) => {
                        preview += `  - [${act.state}] ${act.metadata?.label || act.toolName || 'unknown'} (Class ${act.reversibilityClass || 'unknown'})\n`;
                    });
                }
                return preview;
            }
            else {
                const action = item.action;
                let preview = `Action ID: ${action.id}\n`;
                preview += `Type: ${action.actionType}\n`;
                if (action.toolName) {
                    preview += `Tool: ${action.toolName}\n`;
                }
                if (action.reversibilityClass) {
                    preview += `Reversibility: Class ${action.reversibilityClass}\n`;
                }
                if (action.parameters) {
                    preview += `Parameters: ${JSON.stringify(action.parameters, null, 2)}\n`;
                }
                if (action.preSnapshotId) {
                    const store = new SnapshotStore(dbManager);
                    const preSnapshot = dbManager.getSnapshot(action.preSnapshotId);
                    const filePath = preSnapshot ? preSnapshot.filePath : 'file';
                    const preContent = store.getSnapshotContent(action.preSnapshotId)?.toString('utf8');
                    const postContent = action.postSnapshotId
                        ? store.getSnapshotContent(action.postSnapshotId)?.toString('utf8')
                        : null;
                    const diff = generateUnifiedDiff(filePath, preContent, postContent);
                    if (diff) {
                        preview += `File Diff:\n${diff}`;
                    }
                    else {
                        preview += `File path: ${filePath}\n(No changes detected or binary file)`;
                    }
                }
                else if (action.inverseTool) {
                    preview += `Inverse Tool: ${action.inverseTool}\n`;
                    preview += `Inverse Params: ${JSON.stringify(action.inverseParams, null, 2)}\n`;
                }
                return preview;
            }
        }
        const onKeypress = async (str, key) => {
            if (!key)
                return;
            // Ctrl+C, Esc, or 'q' to exit
            if ((key.ctrl && key.name === 'c') || key.name === 'escape' || key.name === 'q') {
                cleanup();
                console.log('\nExited undomcp TUI.');
                resolve();
                return;
            }
            if (key.name === 'up' || key.name === 'k') {
                cursorIndex = (cursorIndex - 1 + items.length) % items.length;
                if (previewItem) {
                    previewItem = items[cursorIndex];
                }
                render();
            }
            else if (key.name === 'down' || key.name === 'j') {
                cursorIndex = (cursorIndex + 1) % items.length;
                if (previewItem) {
                    previewItem = items[cursorIndex];
                }
                render();
            }
            else if (key.name === 'space') {
                const item = items[cursorIndex];
                if (!item.alreadyUndone) {
                    item.selected = !item.selected;
                    if (item.type === 'turn') {
                        const turnActions = items.filter((i) => i.type === 'action' && i.action?.turnId === item.id);
                        turnActions.forEach((act) => {
                            if (!act.alreadyUndone) {
                                act.selected = item.selected;
                            }
                        });
                    }
                    else if (item.type === 'action') {
                        const turnItem = items.find((i) => i.type === 'turn' && i.id === item.action?.turnId);
                        if (turnItem) {
                            const siblingActions = items.filter((i) => i.type === 'action' && i.action?.turnId === turnItem.id);
                            const allSelected = siblingActions.every((act) => act.alreadyUndone || act.selected);
                            turnItem.selected = allSelected;
                        }
                    }
                    render();
                }
            }
            else if (key.name === 'tab') {
                if (previewItem && previewItem.id === items[cursorIndex].id) {
                    previewItem = null;
                }
                else {
                    previewItem = items[cursorIndex];
                }
                render();
            }
            else if (key.name === 'return') {
                cleanup();
                const selectedActions = items.filter((i) => i.type === 'action' && i.selected && !i.alreadyUndone);
                const selectedActionIds = selectedActions.map((i) => i.id);
                if (selectedActionIds.length === 0) {
                    console.log('\nNo actions selected for rollback.');
                    resolve();
                    return;
                }
                console.log(`\nExecuting rollback for ${selectedActionIds.length} actions...\n`);
                const conflictResolver = async (filePath) => {
                    const wasRaw = process.stdin.isRaw;
                    if (wasRaw)
                        process.stdin.setRawMode(false);
                    const rl = readline.createInterface({
                        input: process.stdin,
                        output: process.stdout,
                    });
                    return new Promise((resolvePrompt) => {
                        rl.question(`[Conflict] File "${filePath}" has been modified externally. Overwrite? (y/N): `, (answer) => {
                            rl.close();
                            if (wasRaw)
                                process.stdin.setRawMode(true);
                            const isOverwrite = answer.toLowerCase().startsWith('y');
                            resolvePrompt(isOverwrite ? 'overwrite' : 'exit');
                        });
                    });
                };
                try {
                    const results = await undoController.execute(selectedActionIds, conflictResolver);
                    console.log('Rollback Results:');
                    for (const result of results) {
                        const actionItem = selectedActions.find((a) => a.id === result.actionId);
                        const label = actionItem?.label || `Action ${result.actionId}`;
                        if (result.success) {
                            if (result.outcome === 'file_restored') {
                                console.log(`\x1b[32m✔ [Restored]\x1b[0m ${label}`);
                            }
                            else if (result.outcome === 'mcp_payload_ready') {
                                console.log(`\x1b[32m✔ [Undone (API State)]\x1b[0m ${label}`);
                            }
                            else if (result.outcome === 'skipped') {
                                console.log(`\x1b[33m⚠ [Skipped]\x1b[0m ${label}`);
                            }
                            else if (result.outcome === 'requires_confirmation') {
                                console.log(`\x1b[33m⚠ [Requires Confirmation]\x1b[0m ${label}`);
                            }
                        }
                        else {
                            console.log(`\x1b[31m✘ [Failed]\x1b[0m ${label}: ${result.error || 'Unknown error'}`);
                        }
                    }
                }
                catch (err) {
                    console.error(`Rollback failed: ${err.message}`);
                }
                resolve();
            }
        };
        function cleanup() {
            process.stdin.removeListener('keypress', onKeypress);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            process.stdin.pause();
        }
        // Set raw mode and register listener
        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        process.stdin.on('keypress', onKeypress);
        // Initial render
        render();
    });
}
