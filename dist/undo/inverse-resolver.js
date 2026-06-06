/**
 * InverseResolver — Automatically determines the compensating (inverse) tool call
 * for a given logged action using verb-matching heuristics and parameter mapping
 * from cached tool schemas.
 */
const VERB_PAIRS = [
    { forwardPattern: /^create[_-]/, forwardPrefix: 'create', inversePrefix: 'delete', confidence: 0.9 },
    { forwardPattern: /^add[_-]/, forwardPrefix: 'add', inversePrefix: 'remove', confidence: 0.9 },
    { forwardPattern: /^insert[_-]/, forwardPrefix: 'insert', inversePrefix: 'delete', confidence: 0.85 },
    { forwardPattern: /^post[_-]/, forwardPrefix: 'post', inversePrefix: 'delete', confidence: 0.8 },
    { forwardPattern: /^enable[_-]/, forwardPrefix: 'enable', inversePrefix: 'disable', confidence: 0.9 },
    // Reverse direction (for symmetry when undoing a delete)
    { forwardPattern: /^delete[_-]/, forwardPrefix: 'delete', inversePrefix: 'create', confidence: 0.7 },
    { forwardPattern: /^remove[_-]/, forwardPrefix: 'remove', inversePrefix: 'add', confidence: 0.7 },
    { forwardPattern: /^disable[_-]/, forwardPrefix: 'disable', inversePrefix: 'enable', confidence: 0.9 },
];
/**
 * Keys commonly used as resource identifiers in API responses.
 */
const ID_FIELD_PATTERNS = [
    /^id$/i,
    /^uid$/i,
    /^_id$/i,
    /^\$id$/i,
    /^key$/i,
    /^name$/i,
    /_id$/i, // e.g., user_id, project_id
    /Id$/, // e.g., userId, projectId
];
export class InverseResolver {
    schemaCache;
    constructor(schemaCache) {
        this.schemaCache = schemaCache;
    }
    /**
     * Main entry point. Given a logged action, attempts to resolve an inverse.
     *
     * Resolution order (highest to lowest confidence):
     * 1. File-system shadow (Class A) — if the action is a file change with a pre-snapshot.
     * 2. Verb-pair heuristic (Class B) — match tool name to an inverse tool in the schema cache.
     * 3. Same-tool restore (Class C) — for update/set operations where pre-state params exist.
     */
    resolve(action) {
        // 1. File-system shadow (Class A)
        const fileShadow = this.resolveFileShadow(action);
        if (fileShadow)
            return fileShadow;
        // 2. Verb-pair heuristic (Class B)
        const verbPair = this.resolveVerbPair(action);
        if (verbPair)
            return verbPair;
        // 3. Same-tool restore (Class C)
        const sameToolRestore = this.resolveSameToolRestore(action);
        if (sameToolRestore)
            return sameToolRestore;
        return null;
    }
    /**
     * Bulk-resolve all actions in a turn, returned in reverse sequence order
     * (last action first) for correct undo ordering.
     */
    resolveForTurn(actions) {
        // Sort descending by sequence number for reverse-order undo
        const sorted = [...actions].sort((a, b) => b.sequenceNum - a.sequenceNum);
        return sorted.map(action => this.resolve(action));
    }
    // --- Resolution strategies ---
    resolveFileShadow(action) {
        if (action.actionType !== 'file_change')
            return null;
        if (action.parameters?.operation === 'create') {
            return {
                inverseTool: '__file_delete__',
                inverseParams: {
                    filePath: action.parameters?.filePath || action.parameters?.path || '',
                    postHash: action.postHash,
                },
                source: 'filesystem_shadow',
                confidence: 1.0,
                reversibilityClass: 'A',
            };
        }
        if (!action.preSnapshotId)
            return null;
        // For file changes, the inverse is "restore from pre-snapshot".
        // The undo controller handles the actual file restore; we just
        // signal that it's possible and provide the metadata.
        return {
            inverseTool: '__file_restore__',
            inverseParams: {
                snapshotId: action.preSnapshotId,
                filePath: action.parameters?.filePath || action.parameters?.path || '',
                operation: action.parameters?.operation || 'restore',
            },
            source: 'filesystem_shadow',
            confidence: 1.0,
            reversibilityClass: 'A',
        };
    }
    resolveVerbPair(action) {
        if (!action.toolName)
            return null;
        const toolName = action.toolName;
        for (const pair of VERB_PAIRS) {
            if (!pair.forwardPattern.test(toolName))
                continue;
            // Build the candidate inverse tool name
            const inverseName = toolName.replace(new RegExp(`^${pair.forwardPrefix}`), pair.inversePrefix);
            // Check if the inverse tool exists in the schema cache
            const inverseSchema = this.schemaCache.getToolSchema(inverseName);
            if (!inverseSchema)
                continue;
            // Map parameters from original action to inverse tool
            const inverseParams = this.mapParams(action, inverseName);
            if (!inverseParams)
                continue;
            return {
                inverseTool: inverseName,
                inverseParams,
                source: 'heuristic',
                confidence: pair.confidence,
                reversibilityClass: 'B',
            };
        }
        return null;
    }
    resolveSameToolRestore(action) {
        if (!action.toolName)
            return null;
        // Only applies to update/set/modify operations
        const isUpdateOp = /^(update|set|modify|patch|put)[_-]/i.test(action.toolName);
        if (!isUpdateOp)
            return null;
        // We need the original parameters to restore the pre-state
        if (!action.parameters || Object.keys(action.parameters).length === 0)
            return null;
        // Verify the tool still exists in schema cache
        const schema = this.schemaCache.getToolSchema(action.toolName);
        if (!schema)
            return null;
        return {
            inverseTool: action.toolName,
            inverseParams: { ...action.parameters },
            source: 'heuristic',
            confidence: 0.5,
            reversibilityClass: 'C',
        };
    }
    // --- Parameter mapping ---
    /**
     * Maps identifier fields from the original action's result data (and parameters)
     * into the inverse tool's required input parameters.
     */
    mapParams(action, inverseToolName) {
        const requiredParams = this.schemaCache.getRequiredParams(inverseToolName);
        const propertyNames = this.schemaCache.getPropertyNames(inverseToolName);
        const allInverseParams = new Set([...requiredParams, ...propertyNames]);
        const result = {};
        // Source pools: result data first (higher priority), then original parameters
        const resultData = action.resultData || {};
        const originalParams = action.parameters || {};
        // Extract all identifier-like fields from result data
        const idFields = this.extractIdFields(resultData);
        // Try to fill every required param
        for (const param of requiredParams) {
            const value = this.findValueForParam(param, idFields, resultData, originalParams);
            if (value === undefined) {
                // Cannot satisfy a required parameter — bail out
                return null;
            }
            result[param] = value;
        }
        // Optionally fill non-required params that have clear matches
        for (const param of allInverseParams) {
            if (result[param] !== undefined)
                continue; // already filled
            const value = this.findValueForParam(param, idFields, resultData, originalParams);
            if (value !== undefined) {
                result[param] = value;
            }
        }
        return result;
    }
    /**
     * Extracts fields that look like resource identifiers from a data object.
     */
    extractIdFields(data) {
        const fields = new Map();
        for (const [key, value] of Object.entries(data)) {
            for (const pattern of ID_FIELD_PATTERNS) {
                if (pattern.test(key)) {
                    fields.set(key, value);
                    break;
                }
            }
        }
        return fields;
    }
    /**
     * Finds a value for a target parameter by searching id fields, result data,
     * and original parameters in priority order.
     */
    findValueForParam(targetParam, idFields, resultData, originalParams) {
        // 1. Exact match in id fields from result data
        if (idFields.has(targetParam)) {
            return idFields.get(targetParam);
        }
        // 2. Case-insensitive match in id fields
        for (const [key, value] of idFields) {
            if (key.toLowerCase() === targetParam.toLowerCase()) {
                return value;
            }
        }
        // 3. Direct match in result data
        if (targetParam in resultData) {
            return resultData[targetParam];
        }
        // 4. Direct match in original parameters
        if (targetParam in originalParams) {
            return originalParams[targetParam];
        }
        // 5. Case-insensitive match in original parameters
        for (const [key, value] of Object.entries(originalParams)) {
            if (key.toLowerCase() === targetParam.toLowerCase()) {
                return value;
            }
        }
        return undefined;
    }
}
