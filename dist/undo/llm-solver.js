export class LlmSolver {
    config;
    constructor(config) {
        this.config = config;
    }
    /**
     * Creates an LlmSolver from environment variables.
     * Returns null if UNDOMCP_LLM_ENDPOINT is not set.
     */
    static fromEnv() {
        const endpoint = process.env.UNDOMCP_LLM_ENDPOINT;
        if (!endpoint)
            return null;
        return new LlmSolver({
            enabled: true,
            endpoint,
            apiKey: process.env.UNDOMCP_LLM_API_KEY,
            model: process.env.UNDOMCP_LLM_MODEL,
            timeoutMs: process.env.UNDOMCP_LLM_TIMEOUT_MS
                ? parseInt(process.env.UNDOMCP_LLM_TIMEOUT_MS, 10)
                : 30000,
        });
    }
    /**
     * Attempts to synthesize a compensating tool call using an LLM.
     *
     * Returns an InverseResolution with reversibilityClass 'D' and source 'llm_suggestion',
     * or null if the solver is disabled, unreachable, or the LLM response is invalid.
     */
    async solve(action, schemaCache) {
        if (!this.config.enabled)
            return null;
        if (!this.config.endpoint)
            return null;
        try {
            const prompt = this.buildPrompt(action, schemaCache);
            const rawResponse = await this.callLlm(prompt);
            if (!rawResponse)
                return null;
            const parsed = this.parseResponse(rawResponse);
            if (!parsed)
                return null;
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
        }
        catch (err) {
            console.error(`[undomcp] LLM solver error: ${err.message}`);
            return null;
        }
    }
    /**
     * Builds the prompt string for the LLM, including the original action
     * context and the full list of available tool schemas.
     */
    buildPrompt(action, schemaCache) {
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
    async callLlm(prompt) {
        const endpoint = this.config.endpoint;
        const timeoutMs = this.config.timeoutMs ?? 30000;
        const headers = {
            'Content-Type': 'application/json',
        };
        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }
        // Build request body — supports both OpenAI-compatible and Ollama formats
        const body = {
            model: this.config.model || 'default',
            stream: false,
        };
        // OpenAI-compatible format
        if (endpoint.includes('/chat/completions')) {
            body.messages = [{ role: 'user', content: prompt }];
        }
        else {
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
            const data = await response.json();
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
        }
        catch (err) {
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
    parseResponse(raw) {
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
        }
        catch {
            return null;
        }
    }
    /**
     * Validates that the inverse params satisfy the target tool's required fields.
     */
    validateParams(params, schema) {
        const required = schema.inputSchema?.required;
        if (!Array.isArray(required))
            return true; // No required fields = valid
        for (const field of required) {
            if (!(field in params)) {
                return false;
            }
        }
        return true;
    }
}
