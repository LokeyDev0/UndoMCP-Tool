/**
 * InverseResolver — Automatically determines the compensating (inverse) tool call
 * for a given logged action using verb-matching heuristics and parameter mapping
 * from cached tool schemas.
 */
import { SchemaCache } from './schema-cache.js';
import { Action } from '../journal/database-manager.js';
export interface InverseResolution {
    inverseTool: string;
    inverseParams: Record<string, any>;
    source: 'filesystem_shadow' | 'heuristic' | 'llm_suggestion';
    confidence: number;
    reversibilityClass: 'A' | 'B' | 'C' | 'D';
}
export declare class InverseResolver {
    private schemaCache;
    constructor(schemaCache: SchemaCache);
    /**
     * Main entry point. Given a logged action, attempts to resolve an inverse.
     *
     * Resolution order (highest to lowest confidence):
     * 1. File-system shadow (Class A) — if the action is a file change with a pre-snapshot.
     * 2. Verb-pair heuristic (Class B) — match tool name to an inverse tool in the schema cache.
     * 3. Same-tool restore (Class C) — for update/set operations where pre-state params exist.
     */
    resolve(action: Action): InverseResolution | null;
    /**
     * Bulk-resolve all actions in a turn, returned in reverse sequence order
     * (last action first) for correct undo ordering.
     */
    resolveForTurn(actions: Action[]): (InverseResolution | null)[];
    private resolveFileShadow;
    private resolveVerbPair;
    private resolveSameToolRestore;
    /**
     * Maps identifier fields from the original action's result data (and parameters)
     * into the inverse tool's required input parameters.
     */
    private mapParams;
    /**
     * Extracts fields that look like resource identifiers from a data object.
     */
    private extractIdFields;
    /**
     * Finds a value for a target parameter by searching id fields, result data,
     * and original parameters in priority order.
     */
    private findValueForParam;
}
