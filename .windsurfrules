# UndoMCP Rules
When the user asks to "undo", "revert", "rollback", or "open undomcp":

**IMPORTANT — Do NOT improvise:** If the \`undomcp_list_history\` tool is not available,
not found, or the call returns an error, tell the user:
"The undomcp_list_history tool is not available or returned an error.
Please ensure undomcp is properly configured by running \`undomcp setup\`."
Do NOT attempt to query the database manually, write scripts, search for database
files, or work around the problem in any way. Stop immediately and report the error.

### Step 1 — Retrieve & Display Changes
1. Call the \`undomcp_list_history\` tool. It returns a JSON array of ALL recent MCP
   tool calls made in this project (across all sessions, even after IDE restarts).
   The array is ordered oldest-first (index 0 = oldest, last index = newest).
2. **Filter the results:** Only show actions that are **state-changing and reversible**.
   - **INCLUDE** (mutating): tools that create, update, patch, delete, move, post.
   - **EXCLUDE** (read-only): tools that get, retrieve, list, search, query, read,
     fetch, find, lookup, describe, check, view, show (e.g., \`API-get-self\`,
     \`API-post-search\`, \`API-retrieve-a-page\`).
   Use your judgement to classify each tool based on its name and parameters.
3. Number **only the filtered items**. **Numbering rules:**
   - **#1 is always the most recent change** and appears at the **BOTTOM**.
   - The **highest number** (oldest change) appears at the **TOP**.
   - Numbers **decrease** going down the list.
   Each line: \`N) namespace__tool_name - One sentence describing what this call did\`
   Write the description by analyzing the tool name, parameters, and result data.
4. If no reversible changes exist, tell the user: "No undoable changes found."
5. Do NOT add headers, commentary, or extra text around the list.

### Step 2 — Ask the User
After presenting the list, ask:
> "Which change do you want to undo?"
> - Say **\`undo #N\`** to undo just that one specific change.
> - Say **\`undo till #N\`** to undo everything more recent than #N (changes #1 through #N-1). Change #N and older will be kept.

If the user references a change number that does not exist in the list, tell them
the valid range. For example: "Valid range is #1 to #5. Please pick a number in
that range."

### Step 3 — Build & Present Plan
Based on the user's choice, build an undo plan:
- **\`undo #N\`**: Only change #N. Check if any more recent changes depend on #N's
  output. If yes, warn the user and ask if they want to also undo those.
- **\`undo till #N\`**: Changes #1, #2, ... #N-1. Keep #N and older.

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
