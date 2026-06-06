/**
 * LlmSolver — Optional LLM-guided fallback for synthesizing compensating payloads
 * when heuristic resolution fails.
 *
 * SAFETY: All LLM-generated plans are Class D (Suggested Only).
 * They are NEVER auto-executed — always presented for user confirmation.
 */

import { SchemaCache, ToolSchema } from './schema-cache.js';
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

interface LlmResponse {
  inverseTool: string;
  inverseParams: Record<string, any>;
  reasoning?: string;
}

export class LlmSolver {
  private config: LlmSolverConfig;

  constructor(config: LlmSolverConfig) {
    this.config = config;
  }

  /**
   * Attempts to synthesize a compensating tool call using an LLM.
   *
   * Returns an InverseResolution with reversibilityClass 'D' and source 'llm_suggestion',
   * or null if the solver is disabled, unreachable, or the LLM response is invalid.
   */
  public async solve(action: Action, schemaCache: SchemaCache): Promise<InverseResolution | null> {
    if (!this.config.enabled) return null;
    if (!this.config.endpoint) return null;

    try {
      const prompt = this.buildPrompt(action, schemaCache);
      const rawResponse = await this.callLlm(prompt);
      if (!rawResponse) return null;

      const parsed = this.parseResponse(rawResponse);
      if (!parsed) return null;

      // Validate that the suggested inverse tool exists in the schema cache
      const targetSchema = schemaCache.getToolSchema(parsed.inverseTool);
      const schemaValid = targetSchema !== null && this.validateParams(parsed.inverseParams, targetSchema);

      return {
        inverseTool: parsed.inverseTool,
        inverseParams: parsed.inverseParams,
        source: 'llm_suggestion',
        confidence: schemaValid ? 0.3 : 0.1,
        reversibilityClass: 'D',
      };
    } catch (err: any) {
      console.error(`[undomcp] LLM solver error: ${err.message}`);
      return null;
    }
  }

  /**
   * Builds the prompt string for the LLM, including the original action
   * context and the full list of available tool schemas.
   */
  private buildPrompt(action: Action, schemaCache: SchemaCache): string {
    const allSchemas = schemaCache.getAllSchemas();
    const schemaList = allSchemas.map(s => ({
      name: s.name,
      description: s.description,
      inputSchema: s.inputSchema,
    }));

    return `You are a tool reversion assistant. Given an API tool call that was executed, you must determine the correct compensating (inverse) tool call to undo it.

## Original Tool Call
- Tool Name: ${action.toolName || 'unknown'}
- Parameters: ${JSON.stringify(action.parameters || {}, null, 2)}
- Result: ${JSON.stringify(action.resultData || {}, null, 2)}

## Available Tools
${JSON.stringify(schemaList, null, 2)}

## Instructions
Respond with ONLY a valid JSON object (no markdown, no explanation) with these fields:
{
  "inverseTool": "name_of_the_tool_to_call",
  "inverseParams": { ...parameters for the inverse call... },
  "reasoning": "brief explanation of why this is the correct inverse"
}

If no inverse is possible, respond with: {"inverseTool": "", "inverseParams": {}, "reasoning": "no inverse possible"}`;
  }

  /**
   * Calls the configured LLM endpoint via HTTP POST.
   */
  private async callLlm(prompt: string): Promise<string | null> {
    const endpoint = this.config.endpoint!;
    const timeoutMs = this.config.timeoutMs ?? 30000;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    // Build request body — supports both OpenAI-compatible and Ollama formats
    const body: Record<string, any> = {
      model: this.config.model || 'default',
      stream: false,
    };

    // OpenAI-compatible format
    if (endpoint.includes('/chat/completions')) {
      body.messages = [{ role: 'user', content: prompt }];
    } else {
      // Ollama / generic format
      body.prompt = prompt;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.error(`[undomcp] LLM endpoint returned ${response.status}`);
        return null;
      }

      const data: any = await response.json();

      // Extract text from response — handle both OpenAI and Ollama response formats
      if (data.choices && data.choices[0]?.message?.content) {
        return data.choices[0].message.content;
      }
      if (data.response) {
        return data.response;
      }
      if (typeof data === 'string') {
        return data;
      }

      return null;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        console.error(`[undomcp] LLM request timed out after ${timeoutMs}ms`);
      }
      return null;
    }
  }

  /**
   * Parses the raw LLM response string into a structured LlmResponse.
   */
  private parseResponse(raw: string): LlmResponse | null {
    try {
      // Try to extract JSON from the response (LLMs sometimes wrap in markdown)
      let jsonStr = raw.trim();

      // Strip markdown code fences if present
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
      }

      const parsed = JSON.parse(jsonStr);

      if (!parsed.inverseTool || typeof parsed.inverseTool !== 'string') {
        return null;
      }

      // Empty inverseTool means the LLM says no inverse is possible
      if (parsed.inverseTool === '') {
        return null;
      }

      return {
        inverseTool: parsed.inverseTool,
        inverseParams: parsed.inverseParams || {},
        reasoning: parsed.reasoning,
      };
    } catch {
      return null;
    }
  }

  /**
   * Validates that the inverse params satisfy the target tool's required fields.
   */
  private validateParams(params: Record<string, any>, schema: ToolSchema): boolean {
    const required = schema.inputSchema?.required;
    if (!Array.isArray(required)) return true; // No required fields = valid

    for (const field of required) {
      if (!(field in params)) {
        return false;
      }
    }
    return true;
  }
}
