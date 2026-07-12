<p align="center">
  <h1 align="center">UndoMCP</h1>
  <p align="center"><strong>Ctrl+Z for AI agent actions.</strong></p>
  <p align="center">Universal undo for every MCP tool call, across all IDEs, all servers, all sessions.</p>
</p>

<p align="center">
  <a href="#installation">Install</a> •
  <a href="#how-it-works">How it works</a> •
  <a href="#usage">Usage</a> •
  <a href="#supported-ides">Supported IDEs</a> •
  <a href="#faq">FAQ</a>
</p>

---

## The Problem

Your AI agent edits a Notion page, creates a Stripe customer, modifies an AWS config — all through MCP. Then something goes wrong. There's no undo. You're stuck manually figuring out what changed and reversing it yourself.

## The Solution

UndoMCP silently records every MCP tool call your agent makes. When you want to undo, just say **"undo"** to your AI agent. It shows you what changed, you pick what to reverse, and it handles the rest.

- **Install once, forget forever** — one command, works automatically
- **Works with any MCP server** — Notion, GitHub, Stripe, AWS, filesystem, anything
- **Works across sessions** — close your IDE, reopen, history is still there
- **Works across all IDEs** — Cursor, Claude Code, Windsurf, Codex, VS Code Copilot, and more

---

## Installation

<!-- INSTALLATION_PLACEHOLDER -->

```bash
# Coming soon
```

---

## How It Works

```
┌─────────────────────────────────┐
│  Your IDE / AI Agent            │
│  (Cursor, Claude Code, etc.)    │
└───────────────┬─────────────────┘
                │
                ▼
┌─────────────────────────────────┐
│  UndoMCP (transparent proxy)    │
│  • Logs every tool call         │
│  • Adds "undo" tools            │
│  • Zero latency overhead        │
└───────────────┬─────────────────┘
                │
                ▼
┌─────────────────────────────────┐
│  Your MCP Server                │
│  (Notion, GitHub, Stripe, etc.) │
└─────────────────────────────────┘
```

**That's it.** UndoMCP sits between your agent and MCP servers as a thin proxy. It records what goes through, adds undo capability, and forwards everything transparently. Your MCP servers don't need any changes.

### What happens when you say "undo"

1. You say **"undo"** (or "revert", "rollback") to your AI agent
2. Agent shows you the last 10 state-changing actions (filters out reads automatically)
3. You say **"undo #3"** or **"undo till #5"**
4. Agent figures out the inverse (e.g., `create_page` → trash the page) and executes it
5. Done. Change is reversed and marked in the journal.

### Key design choices

- **Logs everything, filters at display time** — nothing is ever missed
- **AI-driven undo** — your agent reasons about the inverse, not brittle heuristics
- **Dependency detection** — warns you if undoing #3 would break #1 and #2
- **File snapshots** — for filesystem tools, captures file content before/after for perfect restores

---

## Usage

After installation, UndoMCP works automatically. Just talk to your AI agent:

```
You: undo

Agent: Here are your recent MCP changes:
  3) notion__API-post-page - Created page "Meeting Notes"
  2) notion__API-patch-page - Updated title to "Q3 Planning"  
  1) github__create_issue - Created issue #42 "Fix login bug"

Which change do you want to undo?

You: undo till #2

Agent: Will undo #1 and #2. Proceed? (yes/no)

You: yes

Agent: ✔ Undone #1 (deleted issue #42)
       ✔ Undone #2 (reverted page title)
```

### Commands

| Command | What it does |
|---------|-------------|
| `undo` | Show recent undoable changes |
| `undo #N` | Undo just change #N |
| `undo till #N` | Undo changes #1 through #N (inclusive) |

---

## Supported IDEs

UndoMCP auto-detects and configures all of these:

| IDE / Agent | Status |
|-------------|--------|
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

---

## How Setup Works

When you run `undomcp setup`, it:

1. **Detects** which IDEs you have installed
2. **Wraps** their MCP server configs to route through the proxy
3. **Installs** an AI skill file so your agent knows how to handle "undo"

To remove: `undomcp uninstall` — perfectly restores everything to the original state.

---

## FAQ

**Does it slow down my agent?**  
No. The proxy adds <1ms of overhead. It logs asynchronously and forwards immediately.

**Does my MCP server need changes?**  
No. UndoMCP works with any MCP server without modification.

**Where is the data stored?**  
`~/.undomcp/journal.db` — a local SQLite database. Nothing leaves your machine.

**Does it work after restarting my IDE?**  
Yes. History is tied to your project directory, not the session.

**Can it undo everything?**  
If an inverse MCP tool exists (e.g., `delete` for `create`), it undoes automatically. If not, it gives you step-by-step manual instructions.

**What about file changes?**  
File modifications are captured as snapshots (before/after). Undo restores the exact previous content.

**How do I remove it?**  
```bash
undomcp uninstall
```
This restores all IDE configs, removes skill files, and deletes the journal database.

---

## Contributing

Contributions welcome! The codebase is TypeScript, built with:

```bash
npm run build     # Compile
npm run test      # Run tests (vitest)
```

See [AGENT.md](./AGENT.md) for full architecture documentation.

---

## License

MIT © [Lokey](https://github.com/LokeyDev0)
