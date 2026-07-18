/**
 * Shared filtering logic for determining whether an MCP tool call should be
 * recorded in the undo journal.
 *
 * Design principle: if a tool is ambiguous, RECORD it (conservative). Only
 * skip tools we are confident are read-only or are not MCP server tools.
 */

export const NATIVE_TOOLS = new Set([
  'edit', 'bash', 'write', 'read', 'glob', 'grep', 'agent',
  'taskcreate', 'taskupdate', 'taskget', 'tasklist', 'taskstop', 'taskoutput',
  'webfetch', 'websearch', 'notebook', 'notebookedit', 'artifact',
]);

// Base tool names starting with these verbs (followed by separator or end of string) are read-only.
// Requires a word-boundary after the prefix to avoid false matches like "checkout" or "counter".
const READ_ONLY_PREFIX_RE =
  /^(get|list|search|query|read|fetch|find|lookup|describe|check|view|show|info|status|count|retrieve|browse|inspect)([_-]|$)/i;

// Whole-name matches for diagnostic / identity tools that carry no state change.
const READ_ONLY_EXACT_RE = /^(ping|echo|health|version|whoami|me|self|help)$/i;

// Some API-generated tool schemas prefix a semantic verb with an HTTP method.
// e.g. "post-search" is a search endpoint that uses HTTP POST — it is still read-only.
// This pattern catches post/put/patch + a clearly read-only action word.
const HTTP_VERB_READ_ONLY_RE =
  /^(?:post|put|patch)[-_](get|list|search|query|read|fetch|find|lookup|describe|check|view|show|info|status|count|retrieve|browse|inspect)([-_]|$)/i;

// Override: names that start with a read-only prefix but are actually mutations,
// e.g. "get-or-create-page", "find-or-insert-record".
const MUTATION_OVERRIDE_RE =
  /^(?:get|fetch|find|read)[-_](?:or[-_])?(?:create|update|upsert|insert|set)[-_]/i;

/**
 * Strips namespace/server-name prefixes from a full tool name to produce the
 * semantic base name used for read-only classification.
 *
 * Handled conventions:
 *   mcp__server__toolname  (Claude Code hook format)
 *   namespace__toolname    (stdio proxy format)
 *   server-toolname        (server name baked into tool name, e.g. Notion MCP)
 *   API-verb-noun          (auto-generated API tools, e.g. legacy Notion REST)
 *
 * @param fullName  Full tool name as received from the hook/proxy
 * @param namespace Optional pre-known namespace/server name for extra stripping
 */
export function extractBaseToolName(fullName: string, namespace?: string): string {
  let name = (fullName || '').trim();
  if (!name) return '';

  // Strip mcp__server__tool or namespace__tool prefixes
  const dunderIdx = name.indexOf('__');
  if (dunderIdx !== -1) {
    const prefix = name.slice(0, dunderIdx).toLowerCase();
    const rest = name.slice(dunderIdx + 2);
    if (prefix === 'mcp') {
      // mcp__server__toolname — one more level to strip
      const secondIdx = rest.indexOf('__');
      if (secondIdx !== -1) {
        namespace = namespace || rest.slice(0, secondIdx);
        name = rest.slice(secondIdx + 2);
      } else {
        name = rest;
      }
    } else {
      namespace = namespace || prefix;
      name = rest;
    }
  }

  // Strip API- prefix (some tools are named API-post-search, API-retrieve-a-page, etc.)
  if (/^API-/i.test(name)) {
    name = name.slice(4);
  }

  // Some MCP servers prefix every tool name with their own server name, e.g.
  // the Notion MCP server exposes "notion-create-pages" — after stripping the
  // namespace__ prefix we still have "notion-" at the start.
  if (namespace) {
    const ns = namespace.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nsPrefixRe = new RegExp(`^${ns}[-_]`, 'i');
    if (nsPrefixRe.test(name)) {
      name = name.replace(nsPrefixRe, '');
    }
  }

  return name;
}

/**
 * Returns true when the base tool name (already stripped of prefixes) indicates
 * a read-only operation that does not need to be recorded.
 */
export function isReadOnlyTool(baseName: string): boolean {
  if (!baseName) return false;
  // Mutation overrides win — e.g. "get-or-create-page" IS a mutation
  if (MUTATION_OVERRIDE_RE.test(baseName)) return false;
  return (
    READ_ONLY_PREFIX_RE.test(baseName) ||
    READ_ONLY_EXACT_RE.test(baseName) ||
    HTTP_VERB_READ_ONLY_RE.test(baseName)
  );
}

/**
 * Main entry point. Returns true when a tool call should be recorded.
 *
 * Skips:
 *   - UndoMCP's own tools (would create recursive history)
 *   - Known native IDE/agent tools (Bash, Edit, etc.)
 *   - Read-only MCP operations (get, list, search, query, …)
 *
 * Conservative: anything ambiguous is recorded.
 */
export function shouldRecordTool(toolName: string, namespace?: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();

  // Skip undomcp's own tools
  if (lower.startsWith('undomcp_') || lower.startsWith('mcp__undomcp__')) return false;

  // Skip native IDE/agent tools
  if (NATIVE_TOOLS.has(lower)) return false;

  const base = extractBaseToolName(toolName, namespace);
  if (!base) return false;

  // Also check the extracted base name against native tools (handles namespace__NativeTool patterns)
  if (NATIVE_TOOLS.has(base.toLowerCase())) return false;

  return !isReadOnlyTool(base);
}
