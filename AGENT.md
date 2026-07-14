# UndoMCP — Agent Context File

> This file gives any AI coding agent full context on the project: what it is, who
> it's for, how it works, how to navigate the codebase, and what the requirements are.

---

## What Is UndoMCP?

UndoMCP is a **universal undo system for AI agent workflows that use MCP (Model Context Protocol)**. It sits as a transparent JSON-RPC proxy between the user's IDE/agent and any MCP server, intercepting and logging every tool call to a local SQLite database. When the user wants to undo, an AI skill reads the log, shows recent changes, detects dependencies, and reverses them — either automatically via inverse MCP calls or by giving the user manual instructions.

**One-liner:** Ctrl+Z for AI agent actions, across all MCP servers, all IDEs, all sessions.

---

## Target User

- **Who:** Developers and power users who use AI coding agents (Cursor, Claude Code, Windsurf, Codex, Antigravity/Gemini, VS Code Copilot, etc.) with MCP-connected tools (Notion, GitHub, Stripe, AWS, filesystem, databases, any MCP server).
- **Pain point:** AI agents make changes through MCP tools (edit files, create pages, modify configs, call APIs) and there's no way to undo those changes. If the agent does something wrong, the user has to manually figure out what changed and reverse it.
- **Expected behavior:** User installs UndoMCP once ("forget and install"), and from that point on, every MCP action is tracked. When they want to undo, they say "undo" to their AI agent and get a clean list of recent changes they can selectively reverse.

---

## Core Design Principles

1. **Universal:** Works with ANY MCP server without server-side changes. No plugin needed on the MCP server — the proxy intercepts everything transparently.
2. **Forget-and-install:** One `curl | bash` or `npm install -g undomcp && undomcp setup`. No ongoing configuration. No maintenance.
3. **Lightweight:** The proxy adds negligible latency. Logging is fire-and-forget to a local SQLite DB. No network calls during normal operation.
4. **Cross-session:** Undo history persists across IDE restarts, new sessions, different agents. Tied to the project directory, not the session.
5. **IDE-agnostic:** Works across 16+ IDEs/agents. The undo interface is an AI skill/rules file that any LLM-powered agent can follow.
6. **Smart filtering:** Logs ALL MCP calls but only surfaces state-changing actions (mutations) to the user. Read-only calls (search, get, list) are stored for audit but hidden from the undo UI.
7. **Dependency-aware:** Detects when one action depends on another and warns the user before breaking the chain.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  IDE / AI Agent (Cursor, Claude Code, Windsurf, Codex, etc.)         │
│  Thinks it's talking directly to MCP servers                         │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ JSON-RPC over stdio
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  UndoMCP Proxy (ProxyEngine)                                         │
│  • Intercepts ALL tools/call requests                                │
│  • Logs every call to SQLite (~/.undomcp/journal.db)                 │
│  • Captures file snapshots for filesystem tools (pre/post)           │
│  • Injects undomcp_* tools into the agent's tool list                │
│  • Forwards calls transparently to upstream MCP server(s)            │
│  • Logs results (success/failure, latency, result data)              │
│  • Handles undo execution when agent calls undomcp_undo_action       │
└─────────────────────────────────┬────────────────────────────────────┘
                                  │ JSON-RPC over stdio
                                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Real MCP Server(s) (Notion, GitHub, Stripe, AWS, filesystem, etc.)  │
│  Completely unaware of UndoMCP — no changes needed                   │
└──────────────────────────────────────────────────────────────────────┘
```

### How the Proxy Wraps Existing Servers

During `undomcp setup`, the tool rewrites each IDE's MCP config:
- **Original:** `"command": "npx", "args": ["-y", "@notionhq/notion-mcp-server"]`
- **Wrapped:** `"command": "undomcp", "args": ["serve", "--command", "npx", "--args", "-y", "@notionhq/notion-mcp-server"]`

The original command/args are preserved in `__originalCommand` / `__originalArgs` fields for clean restoration via `undomcp setup --restore`.

---

## The Undo Flow (User's Perspective)

1. User is working with their AI agent in any IDE
2. The agent makes MCP calls (edits Notion pages, creates Stripe customers, modifies files, etc.)
3. UndoMCP silently logs every call in the background
4. User says **"undo"** (or "revert", "rollback", "open undomcp")
5. Agent calls `undomcp_list_history` → gets recent MCP actions
6. Agent **filters** to only state-changing actions (mutations, not reads)
7. Agent presents a numbered list:
   ```
   5) notion__API-post-page - Created page "Meeting Notes" in workspace
   4) notion__API-patch-page - Updated title of page "Q3 Planning"
   3) stripe__create_customer - Created customer "cus_abc123"
   2) stripe__create_subscription - Created subscription for cus_abc123
   1) github__create_issue - Created issue #42 "Fix login bug"
   ```
   (#1 = most recent at bottom, highest number = oldest at top)
8. User says **"undo till #3"** → undoes changes 1, 2, and 3 (inclusive)
   OR user says **"undo #4"** → undoes only change 4
9. Agent checks dependencies, warns if needed, presents plan
10. After user confirms, agent calls `undomcp_undo_action` with the action IDs
11. UndoMCP executes the inverses automatically where possible
12. For non-undoable actions, agent gives manual instructions

---

## Key Behaviors & Requirements

### Logging Behavior
- **ALL MCP `tools/call` requests are logged** — both reads and writes
- Logging happens at the proxy level, transparent to both agent and server
- Each action records: tool name, namespace, full parameters (JSON), full result data (JSON), success/failure, latency, timestamp
- Actions are grouped into "turns" by idle-timeout clustering (3 min gap = new turn)
- Project scoping: sessions are tied to `working_directory`. All sessions for the same project share history.

### Filtering Behavior (Display Time Only)
- The database stores ALL calls (reads included) for full audit trail
- Filtering to "only mutations" happens **at display time in the AI skill**, NOT at log time
- The AI agent uses its judgment to classify tool names as actions vs reads:
  - **INCLUDE (mutations):** create, update, patch, delete, move, post, write, edit, set, enable, disable, add, remove, insert
  - **EXCLUDE (reads):** get, retrieve, list, search, query, read, fetch, find, lookup, describe, check, view, show, info, status, count
- This design was chosen because:
  - Pre-classifying at log time would add latency to every MCP call
  - No universal classification works for all MCP servers (e.g., Notion uses POST for searches)
  - Storing everything means nothing is ever accidentally missed
  - Modern AI models trivially handle this filtering

### Undo Semantics
- **`undo #N`** — Undo only change #N. If other changes depend on #N, warn the user.
- **`undo till #N`** — Undo changes #1, #2, #3, ... #N (**inclusive**). Keep everything numbered higher than #N.
- Undo executes in **reverse chronological order** (most recent first): #1, then #2, then #3...
- The AI agent reasons about the inverse and calls the appropriate MCP tool directly
- After executing the inverse, the agent calls `undomcp_undo_action` to mark the action as undone
- For file changes, `undomcp_undo_action` handles snapshot restoration automatically
- If no viable inverse exists, the agent provides manual instructions

### Dependency Detection
Dependencies are detected **programmatically at query time** (when `undomcp_list_history` is called), using three layers:

1. **Direct ID Propagation (high confidence):** If action A's `resultData` produces a value (ID, URL, UUID) that appears in action B's `parameters`, B depends on A. Works universally for Stripe (`cus_xxx`), Notion (page IDs), AWS (ARNs), GitHub (issue numbers), any API.

2. **Same-Resource Sequencing (medium confidence):** If two actions share the same resource identifier in their parameters (e.g., two edits to the same page), later ones are marked as depending on earlier ones.

3. **AI Reasoning (fallback):** For indirect dependencies that programmatic detection misses, the skill instructs the agent to use semantic reasoning on tool names and parameters.

The response includes a `depends_on` array per action so the AI doesn't have to guess.

### Non-Undoable Actions
- Some MCP servers have `create` but no `delete` (or the reverse could be dangerous)
- When no viable inverse tool exists, the AI agent classifies the action as "manual-only"
- The AI agent provides **manual instructions** using actual resource names, IDs, and URLs from the original call data
- The skill organizes manual instructions by application (e.g., "In Notion: go to page X and delete it")

### Cross-Session Persistence
- The SQLite database lives at `~/.undomcp/journal.db`
- Sessions are identified by project directory (normalized path)
- New IDE sessions, IDE restarts, different agents — all see the same history for the same project
- Size limit: 50MB. When exceeded, oldest sessions are pruned (cascading to their turns/actions)

---

## Repository Structure

```
src/
├── index.ts                    # CLI entry (commander.js). Commands: serve, setup, uninstall, clearHistory
├── proxy/
│   ├── engine.ts               # Core proxy: JSON-RPC interception, journaling, undo tool handling
│   └── upstream-manager.ts     # Multi-upstream: spawns child processes, namespaces tools (ns__tool)
├── journal/
│   ├── schema.ts               # SQLite DDL: sessions, turns, actions, snapshots tables + indexes
│   └── database-manager.ts     # CRUD for all tables, project-scoped queries, size enforcement
├── tools/
│   └── undo-tools.ts           # Tool schemas (list_history, mark_turn, undo_action) + handlers
├── undo/
│   ├── schema-cache.ts         # Caches upstream tool schemas for inverse resolution
│   ├── inverse-resolver.ts     # Heuristic verb-pair matching, param mapping, inverse computation
│   ├── undo-controller.ts      # Orchestrates preview + execution pipeline
│   └── llm-solver.ts           # Optional LLM fallback for inverse resolution (Class D, never auto-exec)
├── file-safety/
│   ├── snapshot-store.ts       # Compress/store/retrieve file content snapshots
│   └── conflict-detector.ts    # Hash-based external modification detection
├── utils/
│   └── diff.ts                 # LCS line diff + unified diff generation
├── commands/
│   ├── setup.ts                # IDE detection (16+), TUI selection, config wrapping, skill installation
│   ├── uninstall.ts            # Full cleanup: restore configs, remove skills, delete DB
│   └── clear-history.ts        # Wipe journal.db
tests/                          # Vitest test suite
dist/                           # Compiled JS + platform binaries
legacy/                         # Old compiled-only modules (reference for rewrites)
.cursor/rules/undomcp.mdc      # Cursor IDE rules (auto-installed by setup)
.windsurf/rules/undomcp.md     # Windsurf IDE rules (auto-installed by setup)
install.sh                      # One-liner installer: download binary, PATH, setup
AGENT.md                        # This file
```

---

## Database Schema (SQLite, WAL mode)

**Location:** `~/.undomcp/journal.db`

| Table | Purpose |
|-------|---------|
| `sessions` | One row per proxy instance. Tracks `working_directory` for project scoping. |
| `turns` | Groups actions by idle-timeout (3 min gap = new turn). |
| `actions` | Every `tools/call` logged: tool_name, namespace, parameters, result_data, success, latency, state, reversibility_class, inverse info, snapshot IDs, hashes. |
| `snapshots` | Compressed file content (pre/post) for filesystem tool calls. |

---

## Supported IDEs (Auto-Detected by Setup)

Cursor, Claude Code, Claude Desktop, Windsurf, Codex CLI, Antigravity (Gemini), VS Code Copilot, OpenCode, Kilo Code, Cline, Roo Code, Continue, Zed, JetBrains IDEs, Amazon Q

---

## Tools Exposed by UndoMCP Proxy

| Tool | Purpose |
|------|---------|
| `undomcp_list_history` | Returns recent MCP actions for the current project (across all sessions). Includes `depends_on` annotations. |
| `undomcp_mark_turn` | Explicit turn boundary marker (optional — turns also auto-cluster by idle timeout). |
| `undomcp_undo_action` | Marks action(s) as undone in the journal. Handles file snapshot restoration for file-change actions. MCP inverse calls are handled by the AI agent directly. |

---

## Undo Strategy (AI-Agent-Driven)

The undo system uses an **AI-agent-driven approach** rather than deterministic heuristics:

1. **File-system actions:** The proxy still handles file snapshot restoration automatically via `undomcp_undo_action`. When a file-change action is undone, the pre-snapshot is restored.
2. **MCP tool actions:** The AI agent (not the proxy) reasons about how to reverse MCP calls. The agent:
   - Inspects the action's `toolName`, `parameters`, and `resultData`
   - Parses nested JSON in MCP content wrappers (`content[0].text`)
   - Determines which available MCP tool to call with what arguments
   - Calls the inverse MCP tool directly
   - Then calls `undomcp_undo_action` to mark the action as undone in the journal
3. **Manual-only actions:** When no viable inverse tool exists, the agent provides manual instructions to the user.

This approach is more robust than deterministic heuristics because the AI agent can understand API semantics, parse complex response formats, and handle edge cases across any MCP server.

---

## Development Commands

```bash
npm run build        # TypeScript → dist/
npm run test         # Vitest
npm run build:bin    # Compile platform binaries
npm start            # Run from dist/index.js
```

---

## Key Implementation Details

### The Proxy Intercepts Everything
- `engine.ts` reads JSON-RPC lines from stdin (agent → proxy)
- Parses each line, identifies `tools/call` requests
- Logs to DB BEFORE forwarding upstream
- Forwards to correct upstream via `UpstreamManager` (namespace routing)
- Logs result AFTER response comes back
- Sends response back to agent on stdout

### Multi-Upstream Support
- `UpstreamManager` can manage multiple MCP servers simultaneously
- Tools are namespaced: `notion__create_page`, `stripe__create_customer`
- Routing: tool name prefix before `__` determines which upstream to call
- Single upstream (default): no namespace prefix needed

### Setup Wraps, Doesn't Replace
- Original MCP server configs are preserved in `__originalCommand`/`__originalArgs`
- `undomcp setup --restore` perfectly reverses the wrapping
- `undomcp uninstall` does full cleanup (restore + remove skills + delete DB)
- Backups created before any config modification (`.undomcp-backup` suffix)

### Skills Are the Interface
- The actual undo UX (numbered list, "undo till", dependency warnings, manual guides) is defined in skill/rules files
- These are installed globally (Claude skills dir, Gemini skills dir, Windsurf memories) and per-workspace (.cursorrules, .cursor/rules/, .windsurf/rules/)
- The skill tells the AI agent exactly how to behave when user says "undo"
- This means any LLM-powered agent can provide the undo experience without custom integrations

---

## What NOT To Do

- Do NOT add latency to the hot path (proxy interception → forward → response). Logging must be fire-and-forget.
- Do NOT require the user to configure anything after initial setup.
- Do NOT make assumptions about which MCP servers exist — the tool must work universally.
- Do NOT auto-execute LLM-suggested inverses — always ask user confirmation for Class D.
- Do NOT store filtered/classified actions — store everything raw, filter at display time.
- Do NOT break the proxy if the database is locked or full — gracefully degrade (skip logging, continue forwarding).
