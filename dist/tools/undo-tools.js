const COMMON_EXCLUSIONS = new Set([
    'true', 'false', 'null', 'undefined', 'none', 'yes', 'no',
    'string', 'number', 'boolean', 'object', 'array',
    'content', 'text', 'data', 'type', 'value', 'status', 'result',
]);
/**
 * Determines if a string value looks like a resource identifier.
 */
function isIdentifierLike(s) {
    if (s.length < 6)
        return false;
    if (COMMON_EXCLUSIONS.has(s.toLowerCase()))
        return false;
    // UUID pattern
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))
        return true;
    // Hex ID (24+ chars)
    if (/^[0-9a-f]{24,}$/i.test(s))
        return true;
    // URL-like
    if (s.startsWith('http://') || s.startsWith('https://'))
        return true;
    // Path-like
    if (s.startsWith('/') && s.includes('/'))
        return true;
    // Prefixed ID (cus_xxx, sub_xxx, page_xxx, pi_xxx, etc.) — special case for short prefix IDs
    if (/^[a-z]{2,10}[_-][a-zA-Z0-9]{4,}$/.test(s))
        return true;
    // Generic ID: alphanumeric 8+ chars that aren't all lowercase English words
    if (s.length >= 8 && /^[a-zA-Z0-9_-]{8,}$/.test(s) && /[A-Z0-9]/.test(s))
        return true;
    return false;
}
/**
 * Recursively extracts identifier-like values from an object.
 */
function extractIdentifierValues(data) {
    const values = new Set();
    if (!data || typeof data !== 'object')
        return values;
    const traverse = (obj, depth = 0) => {
        if (depth > 5)
            return; // Don't go too deep
        if (obj === null || obj === undefined)
            return;
        if (typeof obj === 'string') {
            if (isIdentifierLike(obj))
                values.add(obj);
            return;
        }
        if (typeof obj === 'number') {
            if (obj > 1000)
                values.add(String(obj));
            return;
        }
        if (Array.isArray(obj)) {
            for (const item of obj)
                traverse(item, depth + 1);
            return;
        }
        if (typeof obj === 'object') {
            for (const val of Object.values(obj))
                traverse(val, depth + 1);
        }
    };
    traverse(data);
    return values;
}
/**
 * Extracts all string values from an object (for checking consumed values in parameters).
 */
function extractAllStringValues(data) {
    const values = new Set();
    if (!data || typeof data !== 'object')
        return values;
    const traverse = (obj, depth = 0) => {
        if (depth > 5)
            return;
        if (obj === null || obj === undefined)
            return;
        if (typeof obj === 'string') {
            values.add(obj);
            return;
        }
        if (typeof obj === 'number') {
            values.add(String(obj));
            return;
        }
        if (Array.isArray(obj)) {
            for (const item of obj)
                traverse(item, depth + 1);
            return;
        }
        if (typeof obj === 'object') {
            for (const val of Object.values(obj))
                traverse(val, depth + 1);
        }
    };
    traverse(data);
    return values;
}
function intersection(setA, setB) {
    const result = new Set();
    for (const item of setA) {
        if (setB.has(item))
            result.add(item);
    }
    return result;
}
/**
 * Layer 1: Direct ID Propagation — detects when action A's result
 * produces a value consumed by action B's parameters.
 */
function detectDependencies(actions) {
    for (let i = 0; i < actions.length; i++) {
        const producedValues = extractIdentifierValues(actions[i].resultData);
        if (producedValues.size === 0)
            continue;
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
function detectSameResourceDeps(actions) {
    const resourceActions = new Map(); // value -> action indices
    for (let i = 0; i < actions.length; i++) {
        const paramIds = extractIdentifierValues(actions[i].parameters);
        for (const id of paramIds) {
            if (!resourceActions.has(id))
                resourceActions.set(id, []);
            resourceActions.get(id).push(i);
        }
    }
    for (const [resourceId, indices] of resourceActions) {
        if (indices.length < 2)
            continue;
        // Each action depends on the one before it for the same resource
        for (let k = 1; k < indices.length; k++) {
            const laterIdx = indices[k];
            const earlierIdx = indices[k - 1];
            // Avoid duplicates
            const alreadyTracked = actions[laterIdx].depends_on.some((d) => d.action_id === actions[earlierIdx].id);
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
    }
];
// --- Tool Handlers ---
export function handleListHistory(dbManager, workingDirectory, limit = 10) {
    const actions = dbManager.getRecentActionsForProject(workingDirectory, limit);
    const entries = actions.map(a => ({
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
