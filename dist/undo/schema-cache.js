/**
 * SchemaCache — Caches and indexes tool schemas returned by upstream MCP servers.
 *
 * Populated from `tools/list` responses and used by the InverseResolver
 * to discover matching inverse tools and their parameter requirements.
 */
export class SchemaCache {
    schemas = new Map();
    /**
     * Parses the result payload from a `tools/list` JSON-RPC response
     * and stores each tool definition in the internal map.
     *
     * Calling this again replaces all previously cached schemas.
     */
    updateFromToolsList(toolsListResult) {
        if (!toolsListResult || !Array.isArray(toolsListResult.tools)) {
            return;
        }
        this.schemas.clear();
        for (const tool of toolsListResult.tools) {
            if (tool && typeof tool.name === 'string') {
                this.schemas.set(tool.name, {
                    name: tool.name,
                    description: tool.description || '',
                    inputSchema: tool.inputSchema || {},
                });
            }
        }
    }
    /**
     * Returns the schema for a tool by exact name, or null if not cached.
     */
    getToolSchema(toolName) {
        return this.schemas.get(toolName) ?? null;
    }
    /**
     * Returns all cached tool schemas.
     */
    getAllSchemas() {
        return Array.from(this.schemas.values());
    }
    /**
     * Returns the number of cached schemas.
     */
    size() {
        return this.schemas.size;
    }
    /**
     * Removes all cached schemas.
     */
    clear() {
        this.schemas.clear();
    }
    /**
     * Searches for tools whose names match the given regex pattern.
     */
    findToolsByPattern(pattern) {
        const matches = [];
        for (const schema of this.schemas.values()) {
            if (pattern.test(schema.name)) {
                matches.push(schema);
            }
        }
        return matches;
    }
    /**
     * Extracts the `required` field array from a tool's input JSON Schema.
     * Returns an empty array if the tool is not found or has no required fields.
     */
    getRequiredParams(toolName) {
        const schema = this.schemas.get(toolName);
        if (!schema || !schema.inputSchema)
            return [];
        const required = schema.inputSchema.required;
        if (Array.isArray(required)) {
            return required.filter((r) => typeof r === 'string');
        }
        return [];
    }
    /**
     * Extracts property names from a tool's input JSON Schema.
     * Returns an empty array if the tool is not found or has no properties.
     */
    getPropertyNames(toolName) {
        const schema = this.schemas.get(toolName);
        if (!schema || !schema.inputSchema || !schema.inputSchema.properties)
            return [];
        return Object.keys(schema.inputSchema.properties);
    }
}
