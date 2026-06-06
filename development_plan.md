# UndoMCP-Tool — Step-by-Step Development Plan

This document outlines the sequential, step-by-step development process for the **UndoMCP-Tool** (command name: `undomcp`), consistent with the architecture specified in [ARCHITECTURE.md](file:///c:/OpenSourceProject/ARCHITECTURE.md).

---

## Part 1: User Installation & Usage (The Simple Flow)

The tool runs entirely locally on the user's system as a single compiled executable. **No Node.js, NPM, or other runtime dependencies are required for the end-user.**

### 1. One-Click Native Installer
To install the tool, the user runs a single command in their shell:
```powershell
# On Windows (PowerShell):
iwr -useb https://undomcp.dev/install.ps1 | iex
```
```bash
# On macOS/Linux (Shell):
curl -fsSL https://undomcp.dev/install.sh | sh
```
This installer script automatically:
1. Downloads the pre-compiled native binary matching the user's platform (`undomcp.exe` or `undomcp`).
2. Moves the binary to `~/.undomcp/bin`.
3. Appends the binary path to the system `PATH` environment variable.
4. Executes `undomcp setup` automatically to discover installed AI clients (Claude, Cursor, Windsurf, Codex, etc.) and auto-configure their stdio settings to point to the local binary path.

### 2. Single Entrypoint Usage
Users interact with `undomcp` in two simple ways:
- **In Chat (Agent Slash Command):** The user types `/undomcp` (or asks the agent in natural language to *"open undomcp"*). This lists the recent conversational turns and file/API changes, letting the user simply select which changes to undo.
- **In Terminal (CLI TUI):** The user runs `undomcp` with no arguments. This opens a local interactive Terminal User Interface (TUI) checklist showing recent actions grouped by conversational turns. The user toggles checkboxes using the spacebar and presses enter to execute the rollback.

The proxy runs automatically in the background when the agent starts, requiring zero manual startup.

---

## Part 2: Project Directory Structure (Registry-Free)

The project uses pattern-based dynamic rules instead of platform-specific hardcoded registries.

```
undomcp/
├── src/
│   ├── index.ts                    # Entry point & CLI router (launches TUI on zero args)
│   ├── server.ts                   # MCP server setup (stdio transport)
│   │
│   ├── proxy/
│   │   ├── engine.ts               # JSON-RPC interceptor and journal logger
│   │   ├── router.ts               # Namespace parser & request router
│   │   └── upstream-manager.ts     # Manage upstream stdio MCP server processes
│   │
│   ├── journal/
│   │   ├── transaction-log.ts      # SQLite transaction log (WAL mode)
│   │   ├── schema.ts               # Database schema & migrations
│   │   └── retention.ts            # Storage limits & cleanup rules
│   │
│   ├── undo/
│   │   ├── undo-controller.ts      # Creates compensating rollbacks
│   │   ├── inverse-resolver.ts     # Dynamic schema-based inverse mapper
│   │   └── conflict-detector.ts    # SHA-256 baseline state verification
│   │
│   ├── tools/
│   │   └── undo-tools.ts           # MCP tools (undomcp_interactive + auxiliary APIs)
│   │
│   ├── file-safety/
│   │   ├── file-watcher.ts         # Gitignore-aware Chokidar watcher
│   │   ├── snapshot-store.ts       # Zstd-compressed content-addressed store
│   │   └── shadow-store.ts         # Baseline pre-state file index
│   │
│   └── utils/
│       ├── tui.ts                  # Terminal User Interface checkbox selection dashboard
│       ├── diff.ts                 # Unified file diff formatter
│       └── compression.ts          # Zstd compression helpers
│
├── config/
│   └── inverses/                   # Pattern-based generic rules
│       ├── generic_crud.yaml       # REST/CRUD schema matching
│       └── generic_database.yaml   # SQL database resource matching
│
├── adapters/                       # Agent rulesets
│   ├── claude-code/
│   │   └── SKILL.md                # Skill instructions for /undomcp
│   ├── cursor/
│   │   └── undomcp.mdc             # Cursor MDC rules
│   └── windsurf/
│       └── .windsurfrules          # Windsurf Cascade rules
│
└── package.json
```

---

## Part 3: Step-by-Step Development Plan

### Phase 1: Core Foundation & Storage

#### Step 1: Project Scaffolding
* **What it does:** Sets up the TypeScript project configuration, compiler settings, and build scripts.
* **Details:**
  - Create the `package.json` with dependencies (`@modelcontextprotocol/sdk`, `chokidar`, `yaml`, `commander`, `nanoid`, `fzstd` for pure-JS zstd).
  - Configure `tsconfig.json` for ESM output.
  - Setup Vitest for unit testing.
  - *Technical Note on SQLite:* Because we aim for a zero-dependency standalone binary, native C++ bindings (like `better-sqlite3`) require shipping external `.node` files. To solve this, we structure the storage code to support two runtime backends:
    1. **Bun Backend (Primary):** Utilizes Bun's built-in, highly-optimized `bun:sqlite` engine, compiling into a 100% self-contained single executable.
    2. **WASM-SQLite Backend (Fallback):** Utilizes a pure JavaScript/WASM-based SQLite driver for packaging when built with Node.js SEA (Single Executable Applications).

#### Step 2: Database Schema & WAL Migrations
* **What it does:** Sets up the local SQLite database to persist the action journal, file snapshots, and turns.
* **Details:**
  - Open `~/.undomcp/journal.db` with WAL mode enabled to ensure zero logging lag.
  - Create tables: `sessions`, `turns`, `actions`, `snapshots`, `file_index`, and `checkpoints`.
  - Add query indexes on `session_id`, `state`, `timestamp`, and `turn_id`.

---

### Phase 2: Interception Proxy & File Watcher

#### Step 3: Single-Upstream stdio Proxy
* **What it does:** Creates the JSON-RPC proxy bridge that intercepts communications between the AI agent and a downstream MCP server.
* **Details:**
  - Listen on stdio (agent side) and launch/connect to a downstream MCP server process on stdio (upstream side).
  - Forward JSON-RPC requests (`tools/list` and `tools/call`) transparently.

#### Step 4: Transaction Logging
* **What it does:** Inserts pre-action and post-action logging hooks into the proxy pipeline.
* **Details:**
  - Record action metadata in the database before forwarding.
  - Update the action row with success/failure status and response payloads on return.

#### Step 5: Workspace File Watcher
* **What it does:** Monitors files in the workspace directory to catch edits made directly by the agent's built-in tools.
* **Details:**
  - Watch the project directory with Chokidar, ignoring files via `.gitignore` rules.
  - Debounce filesystem events (100ms window) to group bulk edits.

#### Step 6: File Snapshot Engine & Conflict Resolution
* **What it does:** Takes zstd-compressed backups of files immediately before they are changed or deleted, and manages conflict checks.
* **Details:**
  - On file watcher `change` or `unlink` events: Read the baseline content from the shadow-store, compress it with Zstd, and save it in the `snapshots` table.
  - Map watch events to generic actions: `modify` (restore pre-snapshot), `delete` (restore pre-snapshot), and `create` (delete added file).
  - **Conflict check:** Verify the current file hash matches `post_hash` before performing a rollback. If the hashes differ, prompt the user with a diff preview to skip or force-overwrite.

---

### Phase 3: Conversational Turn Tracking

#### Step 7: Time-Based Turn Clustering
* **What it does:** Automatically groups individual tool calls into logical conversational turns (prompts) based on timing.
* **Details:**
  - If the time since the last action completed exceeds `2500ms`, close the previous turn and create a new row in the `turns` table.
  - Link subsequent tool calls in the active burst to this new `turn_id`.

#### Step 8: Active Turn Marking Tool
* **What it does:** Exposes a helper tool that supported agents can call to explicitly define prompt boundaries.
* **Details:**
  - Expose `undomcp_mark_turn(prompt_text)` as a private tool.
  - When called by an agent skill at the start of a prompt turn, it overrides time-based clustering, immediately starts a new turn, and logs the user's actual prompt text.

---

### Phase 4: Dynamic Reversion Engine

#### Step 9: Tool Schema Reflection
* **What it does:** Queries and analyzes the tool schemas of the downstream MCP server to understand what commands exist.
* **Details:**
  - Cache tool definitions returned by the upstream's `tools/list` response.
  - Build a schema index to lookup parameter requirements for all tools on the server.

#### Step 10: Pattern-Based Inverse Resolution
* **What it does:** Automatically maps creation/addition tools to deletion/removal tools using schema parameter heuristics.
* **Details:**
  - **Verb Matching:** Search for corresponding inverse verbs using standardized regex patterns (e.g. `create_*` maps to `delete_*`, `add_*` to `remove_*`, `insert_*` to `delete_*`, `post_*` to `delete_*`).
  - **Parameter Mapping:** Identify returned keys (like `id`, `uid`, `_id`, `$id`, or path variables) from the original tool call output. Dynamic schema mapping matches these fields to the input parameters required by the delete tool.
  - Exclude hardcoded platform registries; focus purely on dynamic JSON Schema reflection.

#### Step 11: LLM-Guided Reversion Solver
* **What it does:** Uses a model sidecar to dynamically synthesize compensating payloads when simple heuristics fail.
* **Details:**
  - Send original call parameters, output JSON, and tool schemas to a local sidecar model when heuristics are ambiguous.
  - Retrieve the synthesized compensating JSON-RPC payload.
  - **Safety constraint:** Mark LLM-synthesized plans as **Class D: Suggested Only**. Never auto-execute them; present them in the TUI/Agent preview and require explicit confirmation.

---

### Phase 5: Reversion Tools & TUI Layer

#### Step 12: Unified Checklist & Auxiliary Tools
* **What it does:** Registers the primary interactive selection tool and supporting backend APIs.
* **Details:**
  - **Primary Entrypoint Tool:** Register the `undomcp_interactive` tool. When called, it outputs the history of recent prompt turns and changes in a clean checklist format, enabling selection-based rollbacks.
  - **Auxiliary Tools:** Implement supporting backend APIs (`undomcp_undo_selection`, `undomcp_list_turns`, `undomcp_preview_undo`, etc.) that execute the rollbacks.

#### Step 13: Local Terminal User Interface (TUI)
* **What it does:** Implements the zero-argument interactive selection interface for local CLI usage.
* **Details:**
  - Build a terminal checkbox checklist (using `inquirer` or a custom readline layout).
  - When running `undomcp` with no arguments, load recent sessions and display a scrollable list of turns and individual file/API edits.
  - Pressing Space toggles selection, Enter triggers the dynamic undo pipeline, and Tab previews changes (inline diffs for files; JSON parameters for API calls).

---

### Phase 6: Namespacing, Installer & Binary Packaging

#### Step 14: Namespace Routing
* **What it does:** Allows the proxy to handle multiple downstream servers at the same time.
* **Details:**
  - Read `undomcp.config.yaml` to launch multiple upstream connections.
  - Namespace tool lists using double underscores (e.g. `server_a__create_item` and `server_b__send_data`).
  - Parse double-underscores (`__`) at execution time to route calls to the correct upstream connection.

#### Step 15: Setup & Installer Script
* **What it does:** Implements the `undomcp setup` command and platform shell scripts to configure client environments.
* **Details:**
  - Write `install.ps1` and `install.sh` to fetch pre-compiled releases and add them to system paths.
  - Implement `undomcp setup` inside the binary to locate client config paths, register the proxy as `"command": "undomcp"`, and copy native adapter rules (like Cursor MDC) into place.

#### Step 16: Binary Compilation, E2E Tests & Release
* **What it does:** Compiles the project into standalone binaries, validates system correctness, and packages it for distribution.
* **Details:**
  - Write integration tests verifying WAL log integrity, watched-file undos, and proxy throughput.
  - **Binary Compilation Build Pipeline:** 
    - Configure the build action to compile the TypeScript project into native standalone executable binaries for Windows, macOS, and Linux.
    - Compile using `bun build --compile` (since Bun embeds native SQLite and zstd compression engines directly inside the executable, producing a 100% self-contained single binary).
    - Setup Node.js SEA (Single Executable Applications) as a secondary build target, bundling pure-JS/WASM drivers to avoid external `.node` file requirements.
  - Publish binaries to GitHub Releases and installer scripts to the CDN.
