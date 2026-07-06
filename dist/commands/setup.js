import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
let overrideClientConfigs = null;
export function setClientConfigsOverride(configs) {
    overrideClientConfigs = configs;
}
export function getClientConfigs() {
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
export function detectInstalledClients() {
    const configs = getClientConfigs();
    const found = [];
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
export async function selectIdesInteractively(detectedClients) {
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
        function moveCursorUp(lines) {
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
            const lines = [];
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
        const onKeypress = (str, key) => {
            if (!key)
                return;
            if ((key.ctrl && key.name === 'c') || key.name === 'q') {
                cleanup();
                console.log('\n\x1b[33mSetup cancelled.\x1b[0m');
                resolve([]);
                return;
            }
            if (key.name === 'up' || key.name === 'k') {
                cursorIndex = (cursorIndex - 1 + totalRows) % totalRows;
                render();
            }
            else if (key.name === 'down' || key.name === 'j') {
                cursorIndex = (cursorIndex + 1) % totalRows;
                render();
            }
            else if (key.name === 'space') {
                if (cursorIndex === 0) {
                    // Toggle "Select All"
                    selectAll = !selectAll;
                    items.forEach((i) => (i.selected = selectAll));
                }
                else {
                    const itemIndex = cursorIndex - 1;
                    items[itemIndex].selected = !items[itemIndex].selected;
                    updateSelectAll();
                }
                render();
            }
            else if (key.name === 'return') {
                cleanup();
                const selected = items.filter((i) => i.selected);
                if (selected.length === 0) {
                    console.log('\n\x1b[33mNo IDEs selected. Setup cancelled.\x1b[0m');
                }
                else {
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
function shortenPath(filePath) {
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
function backupConfigFile(configPath) {
    const backupPath = configPath + '.undomcp-backup';
    // Only create backup if one doesn't already exist (preserve the original)
    if (!fs.existsSync(backupPath)) {
        try {
            fs.copyFileSync(configPath, backupPath);
            return backupPath;
        }
        catch (err) {
            console.error(`[undomcp] Failed to backup ${configPath}: ${err.message}`);
            return null;
        }
    }
    return backupPath;
}
function getServersKeyForConfig(clientName, configPath, parsed) {
    if (parsed.mcpServers && typeof parsed.mcpServers === 'object')
        return 'mcpServers';
    if (parsed.mcp_servers && typeof parsed.mcp_servers === 'object')
        return 'mcp_servers';
    if (parsed.mcp && typeof parsed.mcp === 'object')
        return 'mcp';
    if (parsed.context_servers && typeof parsed.context_servers === 'object')
        return 'context_servers';
    if (parsed.servers && typeof parsed.servers === 'object')
        return 'servers';
    if (parsed['github.copilot.chat.mcp.servers'] && typeof parsed['github.copilot.chat.mcp.servers'] === 'object')
        return 'github.copilot.chat.mcp.servers';
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
export async function runSetup(options = {}) {
    const configs = getClientConfigs();
    // Detect if running from compiled binary or raw node
    const isCompiled = !process.argv[1] || !process.argv[1].endsWith('.js');
    const undomcpBin = options.binaryPath || (isCompiled ? process.argv[0] : 'undomcp');
    // --- Determine which config files to process ---
    let targetPaths;
    if (options.restore) {
        // Restore mode: process ALL config files that exist (no selection needed)
        targetPaths = new Set();
        for (const config of configs) {
            for (const configPath of config.paths) {
                if (fs.existsSync(configPath)) {
                    targetPaths.add(configPath);
                }
            }
        }
    }
    else if (options.selectedClients) {
        // Programmatic mode: use pre-supplied selection
        targetPaths = new Set(options.selectedClients.map((c) => c.foundPath));
    }
    else if (options.all) {
        // Non-interactive --all flag: configure every detected IDE
        const detected = detectInstalledClients();
        if (detected.length === 0) {
            console.log('[undomcp] No AI agent configuration files found on this system.');
            return;
        }
        targetPaths = new Set(detected.map((c) => c.foundPath));
        console.log(`[undomcp] Found ${detected.length} AI agent(s): ${detected.map((c) => c.name).join(', ')}`);
    }
    else {
        // Interactive mode: detect and let user select
        const detected = detectInstalledClients();
        if (detected.length === 0) {
            console.log('[undomcp] No AI agent configuration files found on this system.');
            console.log('[undomcp] You can manually add undomcp to your MCP config. See: https://github.com/LokeyDev0/UndoMCP-Tool#manual-setup');
            return;
        }
        const isInteractive = process.stdin.isTTY;
        let selected;
        if (isInteractive) {
            selected = await selectIdesInteractively(detected);
            if (selected.length === 0) {
                return; // User cancelled
            }
        }
        else {
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
                let parsed;
                try {
                    parsed = JSON.parse(content);
                }
                catch {
                    // File might be empty or invalid JSON, skip it
                    continue;
                }
                if (!parsed) {
                    continue;
                }
                const serversKey = getServersKeyForConfig(config.name, configPath, parsed);
                let servers = parsed[serversKey];
                let fileChanged = false;
                if (!servers || typeof servers !== 'object') {
                    if (!options.restore) {
                        parsed[serversKey] = {};
                        servers = parsed[serversKey];
                        fileChanged = true;
                    }
                    else {
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
                    if (name === 'undomcp')
                        continue;
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
                    }
                    else {
                        // Wrap server if not already wrapped
                        const isWrapped = srv.command === undomcpBin ||
                            (typeof srv.command === 'string' && srv.command.endsWith('undomcp')) ||
                            (typeof srv.command === 'string' && srv.command.endsWith('undomcp.exe'));
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
                            srv.command = undomcpBin;
                            srv.args = ['serve', '--command', srv.__originalCommand, '--args', ...(srv.__originalArgs || [])];
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
                        servers.undomcp = {
                            command: undomcpBin,
                            args: ['serve', '--command', 'node', '--args', '-e', '""']
                        };
                        fileChanged = true;
                    }
                }
                else {
                    // Restore mode: remove undomcp standalone server only if it matches our added version
                    if (servers.undomcp && Array.isArray(servers.undomcp.args) && servers.undomcp.args.includes('-e')) {
                        delete servers.undomcp;
                        fileChanged = true;
                    }
                }
                if (fileChanged) {
                    fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
                    console.log(`[undomcp] Successfully ${options.restore ? 'restored' : 'configured'} ${config.name} at: ${shortenPath(configPath)}`);
                    modifiedCount++;
                }
            }
            catch (err) {
                console.error(`[undomcp] Error processing ${config.name} config at ${configPath}: ${err.message}`);
            }
        }
    }
    if (!options.restore) {
        installAdapterSkills();
        if (modifiedCount === 0) {
            console.log('[undomcp] No configuration files were updated (already configured).');
        }
        else {
            console.log(`\n\x1b[32m✔ Setup complete! ${modifiedCount} IDE(s) configured.\x1b[0m`);
            console.log('\x1b[2mRun "undomcp setup --restore" to undo these configuration changes.\x1b[0m');
        }
    }
    else {
        removeAdapterSkills();
        console.log(`\n\x1b[32m✔ Restore complete! ${modifiedCount} IDE(s) restored to original configuration.\x1b[0m`);
    }
}
function getSkillsHomeDir() {
    if (overrideClientConfigs && overrideClientConfigs.length > 0) {
        return path.dirname(overrideClientConfigs[0].paths[0]);
    }
    return os.homedir();
}
function getWorkspaceDir() {
    if (overrideClientConfigs && overrideClientConfigs.length > 0) {
        return path.dirname(overrideClientConfigs[0].paths[0]);
    }
    return process.cwd();
}
function installAdapterSkills() {
    const home = getSkillsHomeDir();
    const cwd = getWorkspaceDir();
    const skillContent = `---
name: undomcp
description: Revert recent MCP tool calls and changes in order
---

# UndoMCP Skill

This skill allows you to view and undo recent MCP tool calls made in this project.

## Instructions

When the user invokes this skill (e.g., via /undomcp or by asking to undo/revert):

**IMPORTANT — Do NOT improvise:** If the \\\`undomcp_list_history\\\` tool is not available,
not found, or the call returns an error, tell the user:
"The undomcp_list_history tool is not available or returned an error.
Please ensure undomcp is properly configured by running \\\`undomcp setup\\\`."
Do NOT attempt to query the database manually, write scripts, search for database
files, or work around the problem in any way. Stop immediately and report the error.

### Step 1 — Retrieve & Display Changes
1. Call the \\\`undomcp_list_history\\\` tool. It returns a JSON array of ALL recent MCP
   tool calls made in this project (across all sessions, even after IDE restarts).
   The array is ordered oldest-first (index 0 = oldest, last index = newest).
2. **Filter the results:** Only show actions that are **state-changing and reversible**.
   - **INCLUDE** (mutating): tools that create, update, patch, delete, move, post
     (e.g., \\\`API-post-page\\\`, \\\`API-patch-page\\\`, \\\`API-delete-a-block\\\`,
     \\\`createDocument\\\`, \\\`updateRecord\\\`).
   - **EXCLUDE** (read-only): tools that only read/fetch data like get, retrieve,
     list, search, query, read, fetch, find, lookup, describe, check, view, show,
     info, status, count (e.g., \\\`API-get-self\\\`, \\\`API-post-search\\\`,
     \\\`API-retrieve-a-page\\\`, \\\`API-get-block-children\\\`, \\\`API-query-data-source\\\`).
   Use your judgement to classify each tool based on its name and parameters.
3. Number **only the filtered items**. **Numbering rules:**
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
4. If no reversible changes exist, tell the user: "No undoable changes found."
5. Do NOT add headers, commentary, or extra text around the list. Only the numbered
   entries.

### Step 2 — Ask the User
After presenting the list, ask:
> "Which change do you want to undo?"
> - Say **\\\`undo #N\\\`** to undo just that one specific change.
> - Say **\\\`undo till #N\\\`** to undo everything more recent than #N (changes #1 through #N-1). Change #N and older will be kept.

If the user references a change number that does not exist in the list, tell them
the valid range. For example: "Valid range is #1 to #5. Please pick a number in
that range."

### Step 3 — Build & Present Plan
Based on the user's choice, build an undo plan:

**Determine which changes to undo:**
- **\\\`undo #N\\\`**: Only change #N. However, you MUST check: do any of the other
  changes (those more recent than #N) depend on the output or side effects of #N?
  If yes, warn the user clearly before proceeding:
  > "Warning: Change #M depends on #N (it references the resource created by #N).
  > If you undo #N without also undoing #M, change #M will break. Do you also want
  > to undo #M?"
  Let the user decide whether to include the dependent changes.
- **\\\`undo till #N\\\`**: Changes #1, #2, #3, ... #N-1 (everything more recent than #N).
  Change #N itself and everything older (#N, #N+1, ... to the end) are kept.

**Classify each change to be undone:**
- **Auto-reversible**: An inverse MCP tool exists that you can call (e.g.,
  \\\`API-post-page\\\` can be undone with \\\`API-patch-page\\\` setting \\\`in_trash: true\\\`;
  \\\`createDocument\\\` can be undone with \\\`deleteDocument\\\`). Determine this by looking
  at the available MCP tools and the parameters/results of the original call.
- **Manual-only**: No inverse MCP tool exists, or the reverse action could be
  harmful or irreversible. Some tools only create but have no destroy counterpart.

**Present the plan as a numbered list showing each change, its classification, and what will happen. Include any dependency warnings.**

Ask the user: **"Do you want to proceed with this plan? (yes/no)"**

Do NOT execute anything until the user explicitly says yes.

### Step 4 — Execute Undo
After the user approves:
1. Execute the auto-reversible changes in order from **most recent first**
   (#1 first, then #2, then #3, etc.).
2. For each change, call the appropriate inverse MCP tool with the correct
   parameters derived from the original call's parameters and results.
3. Be careful not to disturb any changes that were NOT selected for undo.
4. Report the result of each undo step as you go.

**CRITICAL SAFETY RULE:** You must ONLY call the inverse MCP tool for the specific
change(s) the user selected. Do NOT modify, update, or call any other MCP tool for
any other purpose during the undo process. Do NOT make "related" or "cleanup"
changes that the user did not explicitly approve. If you are unsure whether an
inverse call is safe, classify it as manual-only and let the user handle it.

### Step 5 — Summary & Manual Guide
After all automated undos are complete:

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
When the user asks to "undo", "revert", "rollback", or "open undomcp":

**IMPORTANT — Do NOT improvise:** If the \\\`undomcp_list_history\\\` tool is not available,
not found, or the call returns an error, tell the user:
"The undomcp_list_history tool is not available or returned an error.
Please ensure undomcp is properly configured by running \\\`undomcp setup\\\`."
Do NOT attempt to query the database manually, write scripts, search for database
files, or work around the problem in any way. Stop immediately and report the error.

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
3. Number **only the filtered items**. **Numbering rules:**
   - **#1 is always the most recent change** and appears at the **BOTTOM**.
   - The **highest number** (oldest change) appears at the **TOP**.
   - Numbers **decrease** going down the list.
   Each line: \\\`N) namespace__tool_name - One sentence describing what this call did\\\`
   Write the description by analyzing the tool name, parameters, and result data.
4. If no reversible changes exist, tell the user: "No undoable changes found."
5. Do NOT add headers, commentary, or extra text around the list.

### Step 2 — Ask the User
After presenting the list, ask:
> "Which change do you want to undo?"
> - Say **\\\`undo #N\\\`** to undo just that one specific change.
> - Say **\\\`undo till #N\\\`** to undo everything more recent than #N (changes #1 through #N-1). Change #N and older will be kept.

If the user references a change number that does not exist in the list, tell them
the valid range. For example: "Valid range is #1 to #5. Please pick a number in
that range."

### Step 3 — Build & Present Plan
Based on the user's choice, build an undo plan:
- **\\\`undo #N\\\`**: Only change #N. Check if any more recent changes depend on #N's
  output. If yes, warn the user and ask if they want to also undo those.
- **\\\`undo till #N\\\`**: Changes #1, #2, ... #N-1. Keep #N and older.

For each change, classify as:
- **Auto-reversible**: An inverse MCP tool exists.
- **Manual-only**: No inverse exists or reversal could be harmful.

Present the plan with classifications and dependency warnings. Ask the user to
confirm before executing.

### Step 4 — Execute Undo
After approval, execute auto-reversible changes from most recent first. Report
each step. Do not disturb unselected changes.

**CRITICAL SAFETY RULE:** You must ONLY call the inverse MCP tool for the specific
change(s) the user selected. Do NOT modify, update, or call any other MCP tool for
any other purpose during the undo process. Do NOT make "related" or "cleanup"
changes that the user did not explicitly approve.

### Step 5 — Summary & Manual Guide
Show a success summary. If any changes were manual-only, present a "Manual Undo
Guide" organized by application with specific step-by-step instructions using
actual resource names and IDs from the original call data.
`;
    const textRulesContent = `# UndoMCP Rules
When the user asks to "undo", "revert", "rollback", or "open undomcp":

**IMPORTANT — Do NOT improvise:** If the \\\`undomcp_list_history\\\` tool is not available,
not found, or the call returns an error, tell the user:
"The undomcp_list_history tool is not available or returned an error.
Please ensure undomcp is properly configured by running \\\`undomcp setup\\\`."
Do NOT attempt to query the database manually, write scripts, search for database
files, or work around the problem in any way. Stop immediately and report the error.

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
3. Number **only the filtered items**. **Numbering rules:**
   - **#1 is always the most recent change** and appears at the **BOTTOM**.
   - The **highest number** (oldest change) appears at the **TOP**.
   - Numbers **decrease** going down the list.
   Each line: \\\`N) namespace__tool_name - One sentence describing what this call did\\\`
   Write the description by analyzing the tool name, parameters, and result data.
4. If no reversible changes exist, tell the user: "No undoable changes found."
5. Do NOT add headers, commentary, or extra text around the list.

### Step 2 — Ask the User
After presenting the list, ask:
> "Which change do you want to undo?"
> - Say **\\\`undo #N\\\`** to undo just that one specific change.
> - Say **\\\`undo till #N\\\`** to undo everything more recent than #N (changes #1 through #N-1). Change #N and older will be kept.

If the user references a change number that does not exist in the list, tell them
the valid range. For example: "Valid range is #1 to #5. Please pick a number in
that range."

### Step 3 — Build & Present Plan
Based on the user's choice, build an undo plan:
- **\\\`undo #N\\\`**: Only change #N. Check if any more recent changes depend on #N's
  output. If yes, warn the user and ask if they want to also undo those.
- **\\\`undo till #N\\\`**: Changes #1, #2, ... #N-1. Keep #N and older.

For each change, classify as:
- **Auto-reversible**: An inverse MCP tool exists.
- **Manual-only**: No inverse exists or reversal could be harmful.

Present the plan with classifications and dependency warnings. Ask the user to
confirm before executing.

### Step 4 — Execute Undo
After approval, execute auto-reversible changes from most recent first. Report
each step. Do not disturb unselected changes.

**CRITICAL SAFETY RULE:** You must ONLY call the inverse MCP tool for the specific
change(s) the user selected. Do NOT modify, update, or call any other MCP tool for
any other purpose during the undo process. Do NOT make "related" or "cleanup"
changes that the user did not explicitly approve.

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
    }
    catch (err) {
        console.error(`[undomcp] Failed to install Claude Code skill: ${err.message}`);
    }
    // 2. Gemini / Antigravity Global Skill
    const geminiSkillsDir = path.join(home, '.gemini/config/skills/undomcp');
    try {
        fs.mkdirSync(geminiSkillsDir, { recursive: true });
        fs.writeFileSync(path.join(geminiSkillsDir, 'SKILL.md'), skillContent, 'utf8');
        console.log(`[undomcp] Installed Gemini/Antigravity global skill at: ${shortenPath(path.join(geminiSkillsDir, 'SKILL.md'))}`);
    }
    catch (err) {
        console.error(`[undomcp] Failed to install Gemini skill: ${err.message}`);
    }
    // 3. Windsurf Global Rules
    const windsurfMemoriesDir = path.join(home, '.codeium/windsurf/memories');
    try {
        fs.mkdirSync(windsurfMemoriesDir, { recursive: true });
        fs.writeFileSync(path.join(windsurfMemoriesDir, 'global_rules.md'), textRulesContent, 'utf8');
        console.log(`[undomcp] Installed Windsurf global rules at: ${shortenPath(path.join(windsurfMemoriesDir, 'global_rules.md'))}`);
    }
    catch (err) {
        console.error(`[undomcp] Failed to install Windsurf global rules: ${err.message}`);
    }
    // 4. Local Workspace rules (Cursor & Windsurf)
    const cursorRulesDir = path.join(cwd, '.cursor/rules');
    const windsurfRulesDir = path.join(cwd, '.windsurf/rules');
    // Write to .cursorrules at root
    try {
        fs.writeFileSync(path.join(cwd, '.cursorrules'), textRulesContent, 'utf8');
        console.log(`[undomcp] Installed local .cursorrules in current workspace`);
    }
    catch { }
    // Write to .cursor/rules/undomcp.mdc
    try {
        fs.mkdirSync(cursorRulesDir, { recursive: true });
        fs.writeFileSync(path.join(cursorRulesDir, 'undomcp.mdc'), mdcContent, 'utf8');
        console.log(`[undomcp] Installed local .cursor/rules/undomcp.mdc in current workspace`);
    }
    catch { }
    // Write to .windsurfrules at root
    try {
        fs.writeFileSync(path.join(cwd, '.windsurfrules'), textRulesContent, 'utf8');
        console.log(`[undomcp] Installed local .windsurfrules in current workspace`);
    }
    catch { }
    // Write to .windsurf/rules/undomcp.md
    try {
        fs.mkdirSync(windsurfRulesDir, { recursive: true });
        fs.writeFileSync(path.join(windsurfRulesDir, 'undomcp.md'), textRulesContent, 'utf8');
        console.log(`[undomcp] Installed local .windsurf/rules/undomcp.md in current workspace`);
    }
    catch { }
}
function removeAdapterSkills() {
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
    }
    catch { }
    try {
        if (fs.existsSync(geminiSkillsDir)) {
            fs.rmSync(geminiSkillsDir, { recursive: true, force: true });
            console.log(`[undomcp] Removed Gemini/Antigravity global skill.`);
        }
    }
    catch { }
    try {
        if (fs.existsSync(windsurfGlobalRules)) {
            fs.unlinkSync(windsurfGlobalRules);
            console.log(`[undomcp] Removed Windsurf global rules.`);
        }
    }
    catch { }
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
    }
    catch { }
}
