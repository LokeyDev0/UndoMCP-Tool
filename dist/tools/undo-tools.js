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
        description: 'List the most recent MCP tool calls made in the current project (across all sessions). Returns tool names, parameters, and results.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', default: 10, description: 'Number of recent changes to return (default: 10)' }
            }
        }
    }
];
export function handleListHistory(dbManager, workingDirectory, limit = 10) {
    const actions = dbManager.getRecentActionsForProject(workingDirectory, limit);
    return actions.map(a => ({
        id: a.id,
        sessionId: a.sessionId,
        timestamp: a.timestamp,
        toolName: a.toolName,
        namespace: a.namespace,
        parameters: a.parameters,
        success: a.resultSuccess === 1,
        resultData: a.resultData,
        state: a.state
    }));
}
