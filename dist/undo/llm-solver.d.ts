/**
 * LlmSolver — Optional LLM-guided fallback for synthesizing compensating payloads
 * when heuristic resolution fails.
 *
 * SAFETY: All LLM-generated plans are Class D (Suggested Only).
 * They are NEVER auto-executed — always presented for user confirmation.
 *
 * Configuration via environment variables:
 *   UNDOMCP_LLM_ENDPOINT — e.g. "http://localhost:11434/api/generate" or "https://api.openai.com/v1/chat/completions"
 *   UNDOMCP_LLM_API_KEY  — API key for the endpoint
 *   UNDOMCP_LLM_MODEL    — Model name (default: "default")
 */
import { SchemaCache } from './schema-cache.js';
import { Action } from '../journal/database-manager.js';
import { InverseResolution } from './inverse-resolver.js';
export interface LlmSolverConfig {
    enabled: boolean;
    endpoint?: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
}
export declare class LlmSolver {
    private config;
    constructor(config: LlmSolverConfig);
    /**
     * Creates an LlmSolver from environment variables.
     * Returns null if UNDOMCP_LLM_ENDPOINT is not set.
     */
    static fromEnv(): LlmSolver | null;
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
