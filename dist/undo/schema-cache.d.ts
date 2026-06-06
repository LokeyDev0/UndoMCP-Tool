/**
 * SchemaCache — Caches and indexes tool schemas returned by upstream MCP servers.
 *
 * Populated from `tools/list` responses and used by the InverseResolver
 * to discover matching inverse tools and their parameter requirements.
 */
export interface ToolSchema {
    name: string;
    description: string;
    inputSchema: Record<string, any>;
}
export declare class SchemaCache {
    private schemas;
    /**
     * Parses the result payload from a `tools/list` JSON-RPC response
     * and stores each tool definition in the internal map.
     *
     * Calling this again replaces all previously cached schemas.
     */
    updateFromToolsList(toolsListResult: any): void;
    /**
     * Returns the schema for a tool by exact name, or null if not cached.
     */
    getToolSchema(toolName: string): ToolSchema | null;
    /**
     * Returns all cached tool schemas.
     */
    getAllSchemas(): ToolSchema[];
    /**
     * Returns the number of cached schemas.
     */
    size(): number;
    /**
     * Searches for tools whose names match the given regex pattern.
     */
    findToolsByPattern(pattern: RegExp): ToolSchema[];
    /**
     * Extracts the `required` field array from a tool's input JSON Schema.
     * Returns an empty array if the tool is not found or has no required fields.
     */
    getRequiredParams(toolName: string): string[];
    /**
     * Extracts property names from a tool's input JSON Schema.
     * Returns an empty array if the tool is not found or has no properties.
     */
    getPropertyNames(toolName: string): string[];
}
