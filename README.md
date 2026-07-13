<p align="center">
  <h1 align="center">UndoMCP</h1>
  <p align="center"><strong>Ctrl+Z for AI agent actions.</strong></p>
  <p align="center">Undo any MCP tool call. Any server. Any IDE. Across sessions.</p>
</p>

<p align="center">
  <a href="#installation">Install</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#supported-ades">Supported ADEs</a> •
  <a href="#usage">Usage</a> •
  <a href="#uninstall">Uninstall</a>
</p>

---

## The Problem

<<<<<<< HEAD
> AI agents execute powerful actions through MCP—editing Notion pages, creating Stripe customers, modifying AWS configurations, or writing database schemas. But when an agent makes a mistake, **there is no Ctrl+Z.**
=======
> AI agents execute powerful actions through MCP—editing Notion pages, creating Stripe customers, modifying AWS configurations, or writing database schemas. But when an agent makes a critial mistake like , **there is no Ctrl+Z.**
>>>>>>> fc53768cefd50a6da507d6a7fba613424d9f26b0

Currently, you only have two flawed options:

* **Manually undo the change:** This is incredibly time-consuming. Worse, if you rely entirely on AI, you might not even know *how* to manually fix a broken AWS config or a corrupted Supabase database.

* **Ask the agent to undo it inside of the session:** LLMs have finite context windows. If you need to revert an action from 10 prompts ago—or from a previous session—the agent will likely lack the clarity, memory, or context to safely roll it back.

## What UndoMCP Does

<<<<<<< HEAD
UndoMCP records every MCP tool call your agent makes inside of a small database. When you invoke `/undomcp`, your agent invokes a skill which looks into the database and shows you what changed and lets you selectively reverse it.

This means you are not limited by the context window of the LLM and you can undo MCP changes across sessions. 
=======
UndoMCP records every MCP tool call your agent makes inside of a small database. When you invoke `/undomcp` , your agent invokes a skill witch looks into the database and shows you what changed and lets you selectively reverse it.

This means the you are not limted by the context window of LLM and you can undo MCP changes across sessions. 
>>>>>>> fc53768cefd50a6da507d6a7fba613424d9f26b0

UndoMcp is a install and forget tool. Works automatically. Persists across sessions.

---

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later) — required for the npm install method

### npm (macOS / Linux / Windows)

```bash
npm install -g undomcp && undomcp setup
```

> On macOS/Linux, if you get a permission error, run with `sudo`:
> ```bash
> sudo npm install -g undomcp && undomcp setup
> ```

### Verify Installation

```bash
undomcp --version
undomcp --help
```

---

## How It Works

UndoMCP is a transparent proxy that sits between your AI agent and MCP servers:

```
  Your AI Agent (Cursor, Claude Code, Windsurf, etc.)
                    │
                    ▼
  ┌─────────────────────────────────┐
  │         UndoMCP Proxy           │
  │  • Records every tool call      │
  │  • Adds undo capability         │
  │  • Zero latency impact          │
  └─────────────────────────────────┘
                    │
                    ▼
  Your MCP Servers (Notion, Stripe, GitHub, etc.)
```

**Setup rewrites your MCP configs** to route through UndoMCP. Your MCP servers don't need any changes. The proxy forwards everything transparently and keeps a local journal at `~/.undomcp/journal.db`.

**When you invoke undo**, the agent:
1. Reads the journal (last 10 state-changing actions, filtered from reads)
2. Shows you a numbered list
3. You pick what to reverse
4. The agent calls the inverse MCP tool (e.g., trashes a created page)
5. Marks the action as undone in the journal

**Cross-session persistence** — history is tied to your project directory, not your session. Close the IDE, reopen, switch agents — the journal is still there.

**Dependency detection** — if undoing action #5 would break action #2 that depends on it, you get a warning before proceeding.

---

## Supported ADEs

UndoMCP auto-detects and configures:

| AI Development Environment | Status |
|---------------------------|--------|
| Cursor | ✅ |
| Claude Code | ✅ |
| Claude Desktop | ✅ |
| Windsurf | ✅ |
| VS Code Copilot | ✅ |
| Codex CLI | ✅ |
| Antigravity (Gemini) | ✅ |
| OpenCode | ✅ |
| Kilo Code | ✅ |
| Cline | ✅ |
| Roo Code | ✅ |
| Continue | ✅ |
| Zed | ✅ |
| JetBrains IDEs | ✅ |
| Amazon Q | ✅ |
| Aider | ✅ |

Works with **any MCP server** — no server-side changes needed.

---

## Usage

After setup, invoke UndoMCP by telling your agent:

- `/undomcp`

The agent will call `undomcp_list_history`, filter to only state-changing actions, and present:

```
5) notion__API-post-page - Created page "Meeting Notes"
4) notion__API-patch-page - Updated title to "Q3 Planning"
3) stripe__create_customer - Created customer cus_abc123
2) stripe__create_subscription - Created subscription for cus_abc123
1) github__create_issue - Created issue #42 "Fix login bug"
```

Then you say:

| Command | Effect |
|---------|--------|
| `undo #3` | Undo only change #3 |
| `undo till #3` | Undo #1, #2, and #3 (inclusive) |

The agent handles the rest — figures out the inverse call, executes it, marks it done.

---

## Uninstall

```bash
undomcp uninstall
```

Restores all MCP configs to their original state, removes skill files, and deletes the journal.

---

## Contributing

```bash
npm run build     # Compile TypeScript
npm run test      # Run tests (vitest)
```

See [AGENT.md](./AGENT.md) for architecture documentation.

---

## License

MIT © [Lokey](https://github.com/LokeyDev0)
