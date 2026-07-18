# UndoMCP — Agent Context

Universal undo system for AI agent MCP workflows. Sits as a transparent JSON-RPC proxy between IDE/agent and MCP servers, logging mutations to SQLite. When the user says "undo", an AI skill reads the log and reverses changes.

**One-liner:** Ctrl+Z for AI agent actions, across all MCP servers and IDEs.

---

## Target User

- **Who:** Developers using AI coding agents (Cursor, Claude Code, Windsurf, Codex, Antigravity/Gemini, VS Code Copilot, etc.) with MCP-connected tools (Notion, GitHub, Stripe, AWS, filesystem, databases, any MCP server).
- **Pain point:** AI agents make changes through MCP tools and there's no way to undo them. If the agent does something wrong, the user has to manually figure out what changed and reverse it.
- **Expected behavior:** User installs UndoMCP once ("forget and install"), and from that point on, every MCP mutation is tracked. When they say "undo", they get a clean list of recent changes they can selectively reverse.

---

## Core Design Principles

1. **Universal:** Works with ANY MCP server without server-side changes.
2. **Forget-and-install:** One `curl | bash` or `npm install -g undomcp && undomcp setup`. No ongoing config.
3. **Lightweight:** Negligible latency. Fire-and-forget logging to local SQLite.
4. **Cross-session:** History persists across IDE restarts. Tied to project directory, not session.
5. **IDE-agnostic:** Works across 16+ IDEs/agents via skill/rules files any LLM can follow.
6. **Smart filtering:** Only mutations are recorded — read-only calls are detected by regex heuristics and skipped at log time.
7. **Dependency-aware:** Detects when one action depends on another and warns before breaking the chain.

---

## Architecture

```
IDE/Agent ──stdio/http──► UndoMCP Proxy ──stdio/http──► Real MCP Server(s)
                              │
                         SQLite journal
                       (~/.undomcp/journal.db)
```

The proxy intercepts `tools/call` JSON-RPC requests, decides whether to log them, forwards to upstream, captures results, and sends responses back. It also injects `undomcp_*` tools into the agent's tool list.

### Read-Only Detection (`src/utils/tool-filter.ts`)

Filtering happens **at log time in the proxy** — read-only calls are never stored in the DB.

The mechanism is **regex-based heuristic matching on verb prefixes**, not a hardcoded list of specific tool names. This makes it fast (single regex test per call, no network lookups) and universal (works for any MCP server without per-server configuration).

**Decision flow (`shouldRecordTool()`):**
1. Skip UndoMCP's own tools (`undomcp_*`)
2. Skip native IDE tools (bash, edit, read, etc. — fixed set of agent-level tools)
3. Strip namespace prefixes to get base verb (`mcp__notion__create-page` → `create-page`)
4. Check mutation override (`get-or-create-*` → IS a mutation, record it)
5. Check read-only patterns:
   - Prefix: `get|list|search|query|read|fetch|find|lookup|...` + separator
   - Exact: `ping|echo|health|version|whoami|...`
   - HTTP verb + read action: `post-search`, `put-get-*` (semantically read-only despite HTTP method)
6. **Default: RECORD.** Anything ambiguous or unrecognized is stored (conservative).

**Namespace stripping** (`extractBaseToolName`) handles:
- `mcp__server__toolname` (Claude Code format)
- `namespace__toolname` (stdio proxy format)
- `API-verb-noun` (auto-generated REST tools like Notion's)
- Server name baked into tool name (`notion-create-pages` with ns `notion` → `create-pages`)

### Proxy Modes

| Mode | Entry point | Use case |
|------|-------------|----------|
| Stdio proxy | `undomcp serve --command ...` | Wraps stdio MCP servers (most IDEs) |
| HTTP proxy | `src/proxy/http-proxy-server.ts` | HTTP/SSE MCP servers |
| ADE hook | `undomcp_report_action` tool / CLI hook | Report actions after-the-fact (Claude Code hooks) |

### Undo Flow

1. Agent calls `undomcp_list_history` → gets recent mutations with dependency annotations
2. Agent presents numbered list to user
3. User says "undo #N" or "undo till #N"
4. Agent reasons about the inverse, calls the MCP tool with `{"__is_undo": true}`
5. Proxy detects `__is_undo`, strips the flag, skips logging, forwards upstream
6. Agent calls `undomcp_undo_action` to mark it done in the journal
7. For file-change actions, `undomcp_undo_action` restores pre-snapshots automatically

---

## Repository Structure

```
src/
├── index.ts                      # CLI entry (serve, setup, uninstall, clearHistory)
├── proxy/
│   ├── engine.ts                 # Core: JSON-RPC interception, journaling, tool injection
│   ├── upstream-manager.ts       # Multi-upstream: spawn processes, namespace routing
│   ├── http-proxy-server.ts      # HTTP/SSE proxy server
│   ├── http-upstream-client.ts   # HTTP client for upstream MCP servers
│   └── http-registry.ts          # Registry for HTTP upstream endpoints
├── journal/
│   ├── schema.ts                 # SQLite DDL (sessions, turns, actions, snapshots)
│   └── database-manager.ts       # CRUD, project-scoped queries, size enforcement
├── tools/
│   ├── undo-tools.ts             # undomcp_* tool schemas + handlers
│   └── truncate.ts               # Result truncation for large responses
├── undo/
│   ├── schema-cache.ts           # Cache upstream tool schemas for inverse resolution
│   ├── inverse-resolver.ts       # Heuristic verb-pair matching, param mapping
│   ├── undo-controller.ts        # Orchestrates preview + execution pipeline
│   └── llm-solver.ts             # LLM fallback for inverse (Class D, never auto-exec)
├── file-safety/
│   ├── snapshot-store.ts         # Compress/store file snapshots (pre/post)
│   └── conflict-detector.ts      # Hash-based external modification detection
├── utils/
│   ├── tool-filter.ts            # Read-only detection (regex heuristics) ← key file
│   ├── label-generator.ts        # Human-readable action labels
│   └── diff.ts                   # LCS line diff + unified diff
├── commands/
│   ├── setup.ts                  # IDE detection, config wrapping, skill install
│   ├── uninstall.ts              # Full cleanup
│   └── clear-history.ts          # Wipe journal.db
tests/                            # Vitest suite
```

---

## Tools Exposed to Agents

| Tool | Purpose |
|------|---------|
| `undomcp_list_history` | Recent mutations for current project. Includes `depends_on` annotations. |
| `undomcp_search_history` | Search history by tool name, parameters, or time range. |
| `undomcp_mark_turn` | Explicit turn boundary (turns also auto-cluster by 3min idle). |
| `undomcp_undo_action` | Mark action(s) as undone. Handles file snapshot restoration. |
| `undomcp_report_action` | Report an action after-the-fact (hook-based integrations). |

---

## Undo Semantics

- **`undo #N`** — Undo only change #N. Warn if other changes depend on it.
- **`undo till #N`** — Undo changes #1 through #N (inclusive, reverse chronological order).
- The AI agent reasons about the inverse and calls the MCP tool with `{"__is_undo": true}`. The proxy strips this flag, skips logging, and forwards upstream.
- After executing the inverse, the agent calls `undomcp_undo_action` to mark it done.
- For file changes, `undomcp_undo_action` restores pre-snapshots automatically.
- If no viable inverse exists, the agent provides manual instructions with resource names/IDs.

---

## Dependency Detection

Detected programmatically when `undomcp_list_history` is called:

1. **Direct ID Propagation:** If action A's result produces a value (ID, URL) that appears in action B's parameters, B depends on A.
2. **Same-Resource Sequencing:** Two actions sharing the same resource identifier → later depends on earlier.
3. **AI Reasoning (fallback):** The skill instructs the agent to use semantic reasoning for indirect dependencies.

The response includes a `depends_on` array per action.

---

## Setup & How Wrapping Works

During `undomcp setup`:
- **Stdio servers:** Command is wrapped: `"command": "undomcp", "args": ["serve", "--command", "<original>", "--args", ...]`
- **HTTP servers (API key):** URL rewritten to local proxy (`http://127.0.0.1:19750/proxy/<name>/`)
- **HTTP servers (OAuth):** Marked with `__undomcp_disabled`, tracked via PostToolUse hook instead
- **Standalone entry:** UndoMCP is also added as its own MCP server (exposes the undo tools)
- **Restore:** `undomcp setup --restore` reverses all wrapping. `undomcp uninstall` does full cleanup.

Supported IDEs: Cursor, Claude Code, Claude Desktop, Windsurf, Codex CLI, Antigravity (Gemini), VS Code Copilot, OpenCode, Kilo Code, Cline, Roo Code, Continue, Zed, JetBrains, Amazon Q

---

## Database Schema (SQLite, WAL mode)

**Location:** `~/.undomcp/journal.db`

| Table | Purpose |
|-------|---------|
| `sessions` | One row per proxy instance. Tracks `working_directory` for project scoping. |
| `turns` | Groups actions by idle-timeout (3 min gap = new turn). |
| `actions` | Every mutation logged: tool_name, namespace, parameters, result_data, success, latency, state, inverse info, snapshot IDs. |
| `snapshots` | Compressed file content (pre/post) for filesystem tool calls. |

Cross-session: all sessions for the same project directory share history. Size limit: 50MB (oldest pruned).

---

## Key Design Decisions

- **Conservative filtering:** Unknown/ambiguous tools always recorded. No false negatives for mutations.
- **No user config for filtering:** Regex heuristics are universal. No per-server allowlist/blocklist needed.
- **AI-driven undo:** The agent reasons about inverses (not deterministic heuristics). More robust across arbitrary MCP servers.
- **`__is_undo` flag:** Prevents undo calls from polluting history. Enables future "redo".
- **Project-scoped persistence:** Sessions tied to `working_directory`. Survives IDE restarts.
- **Zero latency on hot path:** Logging is fire-and-forget. Proxy never blocks forwarding on DB writes.
- **Graceful degradation:** If DB is locked/full, skip logging but keep forwarding. Never break the proxy.

---

## What NOT To Do

- Do NOT add latency to the hot path (proxy → forward → response).
- Do NOT require user configuration after initial setup.
- Do NOT make assumptions about which MCP servers exist — must work universally.
- Do NOT auto-execute LLM-suggested inverses — always ask user confirmation for Class D.
- Do NOT break the proxy if the database is locked or full — gracefully degrade.

---

## Development

```bash
npm run build        # TypeScript → dist/
npm run test         # Vitest
npm run build:bin    # Compile platform binaries
npm start            # Run from dist/index.js
```
