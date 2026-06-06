/**
 * LlmSolver — Optional LLM-guided fallback for synthesizing compensating payloads
 * when heuristic resolution fails.
 *
 * SAFETY: All LLM-generated plans are Class D (Suggested Only).
 * They are NEVER auto-executed — always presented for user confirmation.
 */
import { SchemaCache } from './schema-cache.js';
import { Action } from '../journal/database-manager.js';
import { InverseResolution } from './inverse-resolver.js';
export interface LlmSolverConfig {
    /** Master switch. If false, solve() returns null immediately. */
    enabled: boolean;
    /** HTTP endpoint for the LLM API (e.g., http://localhost:11434/api/generate for Ollama). */
    endpoint?: string;
    /** Model name to request (e.g., "llama3", "gpt-4o-mini"). */
    model?: string;
    /** Optional API key for authenticated endpoints. */
    apiKey?: string;
    /** Request timeout in milliseconds. Defaults to 30000. */
    timeoutMs?: number;
}
export declare class LlmSolver {
    private config;
    constructor(config: LlmSolverConfig);
    /**
     * Attempts to synthesize a compensating tool call using an LLM.
     *
     * Returns an InverseResolution with reversibilityClass 'D' and source 'llm_suggestion',
     * or null if the solver is disabled, unreachable, or the LLM response is invalid.
     */
    solve(action: Action, schemaCache: SchemaCache): Promise<InverseResolution | null>;
    /**
     * Builds the prompt string for the LLM, including the original action
     * context and the full list of available tool schemas.
     */
    private buildPrompt;
    /**
     * Calls the configured LLM endpoint via HTTP POST.
     */
    private callLlm;
    /**
     * Parses the raw LLM response string into a structured LlmResponse.
     */
    private parseResponse;
    /**
     * Validates that the inverse params satisfy the target tool's required fields.
     */
    private validateParams;
}
