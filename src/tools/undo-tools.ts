/**
 * Undo Tools — Defines the MCP tools exposed by the UndoMCP proxy and their handlers.
 */
import { DatabaseManager, Action } from '../journal/database-manager.js';

// --- Dependency Detection (Phase 2) ---

interface Dependency {
  action_id: string;
  shared_values: string[];
  confidence: 'high' | 'medium';
  reason?: string;
}

interface HistoryEntry {
  id: string;
  sessionId: string;
  timestamp: string;
  toolName?: string;
  namespace?: string;
  parameters?: Record<string, any>;
  success: boolean;
  resultData?: Record<string, any>;
  state: string;
  depends_on: Dependency[];
}

const COMMON_EXCLUSIONS = new Set([
  'true', 'false', 'null', 'undefined', 'none', 'yes', 'no',
  'string', 'number', 'boolean', 'object', 'array',
  'content', 'text', 'data', 'type', 'value', 'status', 'result',
]);

/**
 * Determines if a string value looks like a resource identifier.
 */
function isIdentifierLike(s: string): boolean {
  if (s.length < 6) return false;
  if (COMMON_EXCLUSIONS.has(s.toLowerCase())) return false;

  // UUID pattern
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  // Hex ID (24+ chars)
  if (/^[0-9a-f]{24,}$/i.test(s)) return true;
  // URL-like
  if (s.startsWith('http://') || s.startsWith('https://')) return true;
  // Path-like
  if (s.startsWith('/') && s.includes('/')) return true;
  // Prefixed ID (cus_xxx, sub_xxx, page_xxx, pi_xxx, etc.) — special case for short prefix IDs
  if (/^[a-z]{2,10}[_-][a-zA-Z0-9]{4,}$/.test(s)) return true;
  // Generic ID: alphanumeric 8+ chars that aren't all lowercase English words
  if (s.length >= 8 && /^[a-zA-Z0-9_-]{8,}$/.test(s) && /[A-Z0-9]/.test(s)) return true;

  return false;
}

/**
 * Recursively extracts identifier-like values from an object.
 */
function extractIdentifierValues(data: any): Set<string> {
  const values = new Set<string>();
  if (!data || typeof data !== 'object') return values;

  const traverse = (obj: any, depth: number = 0): void => {
    if (depth > 5) return; // Don't go too deep
    if (obj === null || obj === undefined) return;

    if (typeof obj === 'string') {
      if (isIdentifierLike(obj)) values.add(obj);
      return;
    }
    if (typeof obj === 'number') {
      if (obj > 1000) values.add(String(obj));
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) traverse(item, depth + 1);
      return;
    }
    if (typeof obj === 'object') {
      for (const val of Object.values(obj)) traverse(val, depth + 1);
    }
  };

  traverse(data);
  return values;
}

/**
 * Extracts all string values from an object (for checking consumed values in parameters).
 */
function extractAllStringValues(data: any): Set<string> {
  const values = new Set<string>();
  if (!data || typeof data !== 'object') return values;

  const traverse = (obj: any, depth: number = 0): void => {
    if (depth > 5) return;
    if (obj === null || obj === undefined) return;

    if (typeof obj === 'string') {
      values.add(obj);
      return;
    }
    if (typeof obj === 'number') {
      values.add(String(obj));
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) traverse(item, depth + 1);
      return;
    }
    if (typeof obj === 'object') {
      for (const val of Object.values(obj)) traverse(val, depth + 1);
    }
  };

  traverse(data);
  return values;
}

function intersection<T>(setA: Set<T>, setB: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of setA) {
    if (setB.has(item)) result.add(item);
  }
  return result;
}

/**
 * Layer 1: Direct ID Propagation — detects when action A's result
 * produces a value consumed by action B's parameters.
 */
function detectDependencies(actions: HistoryEntry[]): void {
  for (let i = 0; i < actions.length; i++) {
    const producedValues = extractIdentifierValues(actions[i].resultData);
    if (producedValues.size === 0) continue;

    for (let j = i + 1; j < actions.length; j++) {
      const consumedValues = extractAllStringValues(actions[j].parameters);
      const overlap = intersection(producedValues, consumedValues);
      if (overlap.size > 0) {
        actions[j].depends_on.push({
          action_id: actions[i].id,
          shared_values: Array.from(overlap),
          confidence: 'high',
        });
      }
    }
  }
}

/**
 * Layer 2: Same-Resource Sequencing — detects when multiple actions
 * operate on the same resource.
 */
function detectSameResourceDeps(actions: HistoryEntry[]): void {
  const resourceActions = new Map<string, number[]>(); // value -> action indices

  for (let i = 0; i < actions.length; i++) {
    const paramIds = extractIdentifierValues(actions[i].parameters);
    for (const id of paramIds) {
      if (!resourceActions.has(id)) resourceActions.set(id, []);
      resourceActions.get(id)!.push(i);
    }
  }

  for (const [resourceId, indices] of resourceActions) {
    if (indices.length < 2) continue;
    // Each action depends on the one before it for the same resource
    for (let k = 1; k < indices.length; k++) {
      const laterIdx = indices[k];
      const earlierIdx = indices[k - 1];

      // Avoid duplicates
      const alreadyTracked = actions[laterIdx].depends_on.some(
        (d) => d.action_id === actions[earlierIdx].id
      );
      if (!alreadyTracked) {
        actions[laterIdx].depends_on.push({
          action_id: actions[earlierIdx].id,
          shared_values: [resourceId],
          confidence: 'medium',
          reason: 'same_resource',
        });
      }
    }
  }
}

// --- Tool Definitions ---

export const UNDO_TOOLS = [
  {
    name: 'undomcp_mark_turn',
    description: 'Mark the start of a new conversational turn with the user prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt_text: { type: 'string', description: 'The user prompt text' }
      },
      required: ['prompt_text']
    }
  },
  {
    name: 'undomcp_list_history',
    description: 'List the most recent MCP tool calls made in the current project (across all sessions). Returns tool names, parameters, results, and dependency information.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 10, description: 'Number of recent changes to return (default: 10)' },
        namespace: { type: 'string', description: 'Filter by namespace (optional)' },
        tool_name: { type: 'string', description: 'Filter by tool name (optional)' }
      }
    }
  },
  {
    name: 'undomcp_undo_action',
    description: 'Mark one or more logged MCP actions as undone in the journal. Call this AFTER you have already executed the inverse MCP tool call yourself. For file-change actions, this tool still handles snapshot restoration automatically. This tool does NOT execute inverse MCP calls — the AI agent is responsible for reasoning about and executing those directly.',
    inputSchema: {
      type: 'object',
      properties: {
        action_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of action IDs to mark as undone (from undomcp_list_history). For file-change actions, snapshot restoration is handled automatically.'
        }
      },
      required: ['action_ids']
    }
  },
  {
    name: 'undomcp_search_history',
    description: 'Search the history of MCP tool calls for the current project using a natural language description (e.g., "deleting a table in a database" or "messing up Notion documents"). Returns the most relevant matching change, its details, and any dependent actions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language description of the change to search for'
        }
      },
      required: ['query']
    }
  }
];

// --- Search Helpers & Synonyms ---

const CONCEPT_SYNONYMS: Record<string, string[]> = {
  'delet': ['delet', 'remov', 'drop', 'destroy', 'trash', 'unlink', 'clear', 'purg'],
  'delete': ['delet', 'remov', 'drop', 'destroy', 'trash', 'unlink', 'clear', 'purg'],
  'remove': ['delet', 'remov', 'drop', 'destroy', 'trash', 'unlink', 'clear', 'purg'],
  'remov': ['delet', 'remov', 'drop', 'destroy', 'trash', 'unlink', 'clear', 'purg'],
  'drop': ['delet', 'remov', 'drop', 'destroy', 'trash', 'unlink', 'clear', 'purg'],
  'trash': ['delet', 'remov', 'drop', 'destroy', 'trash', 'unlink', 'clear', 'purg'],
  
  'databas': ['databas', 'db', 'sql', 'tabl', 'queri', 'sqlite', 'postgr', 'mysql', 'schema', 'relat'],
  'database': ['databas', 'db', 'sql', 'tabl', 'queri', 'sqlite', 'postgr', 'mysql', 'schema', 'relat'],
  'db': ['databas', 'db', 'sql', 'tabl', 'queri', 'sqlite', 'postgr', 'mysql', 'schema', 'relat'],
  'table': ['databas', 'db', 'sql', 'tabl', 'queri', 'sqlite', 'postgr', 'mysql', 'schema', 'relat'],
  'tabl': ['databas', 'db', 'sql', 'tabl', 'queri', 'sqlite', 'postgr', 'mysql', 'schema', 'relat'],
  'sql': ['databas', 'db', 'sql', 'tabl', 'queri', 'sqlite', 'postgr', 'mysql', 'schema', 'relat'],
  'query': ['databas', 'db', 'sql', 'tabl', 'queri', 'sqlite', 'postgr', 'mysql', 'schema', 'relat'],
  'queri': ['databas', 'db', 'sql', 'tabl', 'queri', 'sqlite', 'postgr', 'mysql', 'schema', 'relat'],
  
  'creat': ['creat', 'add', 'mak', 'new', 'post', 'insert', 'writ', 'put'],
  'create': ['creat', 'add', 'mak', 'new', 'post', 'insert', 'writ', 'put'],
  'add': ['creat', 'add', 'mak', 'new', 'post', 'insert', 'writ', 'put'],
  'make': ['creat', 'add', 'mak', 'new', 'post', 'insert', 'writ', 'put'],
  'mak': ['creat', 'add', 'mak', 'new', 'post', 'insert', 'writ', 'put'],
  'new': ['creat', 'add', 'mak', 'new', 'post', 'insert', 'writ', 'put'],
  'insert': ['creat', 'add', 'mak', 'new', 'post', 'insert', 'writ', 'put'],
  'write': ['creat', 'add', 'mak', 'new', 'post', 'insert', 'writ', 'put'],
  'writ': ['creat', 'add', 'mak', 'new', 'post', 'insert', 'writ', 'put'],
  
  'edit': ['edit', 'modifi', 'updat', 'chang', 'patch', 'replac', 'set'],
  'modify': ['edit', 'modifi', 'updat', 'chang', 'patch', 'replac', 'set'],
  'modifi': ['edit', 'modifi', 'updat', 'chang', 'patch', 'replac', 'set'],
  'update': ['edit', 'modifi', 'updat', 'chang', 'patch', 'replac', 'set'],
  'updat': ['edit', 'modifi', 'updat', 'chang', 'patch', 'replac', 'set'],
  'change': ['edit', 'modifi', 'updat', 'chang', 'patch', 'replac', 'set'],
  'chang': ['edit', 'modifi', 'updat', 'chang', 'patch', 'replac', 'set'],
  'patch': ['edit', 'modifi', 'updat', 'chang', 'patch', 'replac', 'set'],
  'replace': ['edit', 'modifi', 'updat', 'chang', 'patch', 'replac', 'set'],
  'replac': ['edit', 'modifi', 'updat', 'chang', 'patch', 'replac', 'set'],
  
  'file': ['file', 'code', 'path', 'dir', 'director', 'folder'],
  'code': ['file', 'code', 'path', 'dir', 'director', 'folder'],
  'path': ['file', 'code', 'path', 'dir', 'director', 'folder'],
  
  'notion': ['notion', 'page', 'block', 'databas', 'doc'],
  'page': ['notion', 'page', 'block', 'databas', 'doc'],
  'document': ['notion', 'page', 'block', 'databas', 'doc', 'file'],
  'doc': ['notion', 'page', 'block', 'databas', 'doc']
};

function getCleanTokens(query: string): string[] {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'in', 'on', 'at', 'for', 'to', 'of', 'with', 'by', 'and', 'or', 'is', 'are', 'was', 'were',
    'be', 'been', 'about', 'as', 'it', 'this', 'that', 'they', 'them', 'their', 'my', 'your', 'his', 'her', 'us',
    'we', 'i', 'you', 'he', 'she', 'me', 'him', 'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further',
    'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very'
  ]);
  
  const rawWords = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/);
    
  const tokens: string[] = [];
  for (const word of rawWords) {
    if (!word || STOP_WORDS.has(word) || word.length < 2) continue;
    
    let stemmed = word;
    if (word.endsWith('ing') && word.length > 5) stemmed = word.slice(0, -3);
    else if (word.endsWith('ed') && word.length > 4) stemmed = word.slice(0, -2);
    else if (word.endsWith('es') && word.length > 4) stemmed = word.slice(0, -2);
    else if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) stemmed = word.slice(0, -1);
    
    if (stemmed.length >= 2) {
      tokens.push(stemmed);
    }
  }
  return tokens;
}

function calculateSearchScore(action: Action, cleanTokens: string[]): number {
  let score = 0;
  
  const toolName = (action.toolName || '').toLowerCase();
  const namespace = (action.namespace || '').toLowerCase();
  const label = (action.metadata?.label || '').toLowerCase();
  const parametersStr = action.parameters ? JSON.stringify(action.parameters).toLowerCase() : '';
  const resultDataStr = action.resultData ? JSON.stringify(action.resultData).toLowerCase() : '';
  
  for (const token of cleanTokens) {
    const synonyms = CONCEPT_SYNONYMS[token] || [token];
    
    // Check exact token first
    let tokenMatched = false;
    
    if (toolName.includes(token) || namespace.includes(token)) {
      score += 10;
      tokenMatched = true;
    }
    if (label.includes(token)) {
      score += 8;
      tokenMatched = true;
    }
    if (parametersStr.includes(token)) {
      score += 6;
      tokenMatched = true;
    }
    if (resultDataStr.includes(token)) {
      score += 4;
      tokenMatched = true;
    }
    
    // If exact token didn't match, try synonyms
    if (!tokenMatched) {
      for (const syn of synonyms) {
        if (syn === token) continue;
        
        if (toolName.includes(syn) || namespace.includes(syn)) {
          score += 4;
          break; // only score one synonym per token
        }
        if (label.includes(syn)) {
          score += 3;
          break;
        }
        if (parametersStr.includes(syn)) {
          score += 2;
          break;
        }
        if (resultDataStr.includes(syn)) {
          score += 1;
          break;
        }
      }
    }
  }
  
  return score;
}

function findTransitiveDependents(targetId: string, actions: HistoryEntry[]): Set<string> {
  const dependents = new Set<string>();
  const queue = [targetId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const action of actions) {
      if (dependents.has(action.id)) continue;
      
      const isDependent = action.depends_on.some(d => d.action_id === currentId);
      if (isDependent) {
        dependents.add(action.id);
        queue.push(action.id);
      }
    }
  }

  return dependents;
}

// --- Tool Handlers ---

export function handleListHistory(
  dbManager: DatabaseManager,
  workingDirectory: string,
  limit: number = 10
): HistoryEntry[] {
  const actions = dbManager.getRecentActionsForProject(workingDirectory, limit);
  
  const entries: HistoryEntry[] = actions.map(a => ({
    id: a.id,
    sessionId: a.sessionId,
    timestamp: a.timestamp,
    toolName: a.toolName,
    namespace: a.namespace,
    parameters: a.parameters,
    success: a.resultSuccess === 1,
    resultData: a.resultData,
    state: a.state,
    depends_on: [],
  }));

  // Run dependency detection
  detectDependencies(entries);
  detectSameResourceDeps(entries);

  return entries;
}

export function handleSearchHistory(
  dbManager: DatabaseManager,
  workingDirectory: string,
  query: string
): {
  found: boolean;
  matched_action?: HistoryEntry;
  dependents?: HistoryEntry[];
  alternatives?: HistoryEntry[];
} {
  // Retrieve a generous number of recent executed actions for search and dependency mapping
  const actions = dbManager.getRecentActionsForProject(workingDirectory, 1000);
  if (actions.length === 0) {
    return { found: false };
  }

  const cleanTokens = getCleanTokens(query);
  if (cleanTokens.length === 0) {
    return { found: false };
  }

  const scoredCandidates = actions.map(action => {
    const score = calculateSearchScore(action, cleanTokens);
    return { action, score };
  });

  const validCandidates = scoredCandidates
    .filter(c => c.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return new Date(b.action.timestamp).getTime() - new Date(a.action.timestamp).getTime();
    });

  if (validCandidates.length === 0) {
    return { found: false };
  }

  const bestMatch = validCandidates[0].action;

  // Map all loaded actions to HistoryEntry format
  const entries: HistoryEntry[] = actions.map(a => ({
    id: a.id,
    sessionId: a.sessionId,
    timestamp: a.timestamp,
    toolName: a.toolName,
    namespace: a.namespace,
    parameters: a.parameters,
    success: a.resultSuccess === 1,
    resultData: a.resultData,
    state: a.state,
    depends_on: [],
  }));

  // Run dependency detection on the entire list (oldest first)
  detectDependencies(entries);
  detectSameResourceDeps(entries);

  const matchedEntry = entries.find(e => e.id === bestMatch.id)!;
  const dependentIds = findTransitiveDependents(bestMatch.id, entries);
  const dependents = entries.filter(e => dependentIds.has(e.id));

  // Extract up to 3 alternative high scoring matches (excluding the best match)
  const alternatives = validCandidates
    .slice(1, 4)
    .map(c => entries.find(e => e.id === c.action.id)!);

  return {
    found: true,
    matched_action: matchedEntry,
    dependents,
    alternatives
  };
}
