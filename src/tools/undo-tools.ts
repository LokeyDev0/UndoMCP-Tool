import { DatabaseManager, Turn, Action } from '../journal/database-manager.js';
import { UndoController, UndoPreview, UndoResult } from '../undo/undo-controller.js';

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
    name: 'undomcp_interactive',
    description: 'Display recent turns and edits in a clean checklist format to review and select what to undo.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'undomcp_list_turns',
    description: 'List recent conversational turns and summaries of changes made in each turn.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 20, description: 'Max turns to return' }
      }
    }
  },
  {
    name: 'undomcp_preview_undo',
    description: 'Preview what would be undone for a selection of turn IDs or action IDs without executing the rollback.',
    inputSchema: {
      type: 'object',
      properties: {
        actionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific action IDs to preview'
        },
        turnIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific turn IDs to preview'
        }
      }
    }
  },
  {
    name: 'undomcp_undo_selection',
    description: 'Undo a user-selected set of action IDs and/or turn IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        actionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific action IDs to undo'
        },
        turnIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific turn IDs to undo'
        },
        confirmClassD: {
          type: 'boolean',
          default: false,
          description: 'Set to true to confirm execution of Class D (suggested only) actions'
        },
        overwriteConflicts: {
          type: 'boolean',
          default: false,
          description: 'Set to true to overwrite file conflicts'
        }
      }
    }
  }
];

export interface FormattedTurn {
  id: string;
  turnNum: number;
  promptText?: string;
  timestamp: string;
  actions: {
    id: string;
    toolName?: string;
    label?: string;
    state: string;
    reversibilityClass?: string;
  }[];
}

export function handleInteractive(
  dbManager: DatabaseManager,
  sessionId: string
): string {
  const turns = dbManager.getTurnsForSession(sessionId);
  if (turns.length === 0) {
    return 'No turns logged in the current session yet.';
  }

  const actions = dbManager.getActionsForSession(sessionId);
  
  let output = '### Recent turns and changes:\n\n';
  
  // Display turns in reverse order (newest first)
  const sortedTurns = [...turns].sort((a, b) => b.turnNum - a.turnNum);
  
  for (const turn of sortedTurns) {
    const turnActions = actions.filter(a => a.turnId === turn.id);
    const prompt = turn.promptText ? `"${turn.promptText}"` : `Turn #${turn.turnNum}`;
    output += `**Turn #${turn.turnNum}**: ${prompt}  (ID: \`${turn.id}\`)\n`;
    
    if (turnActions.length === 0) {
      output += `  *No actions logged in this turn.*\n\n`;
      continue;
    }
    
    for (const action of turnActions) {
      const stateIcon = action.state === 'undone' ? '✅ [Undone]' : '[ ]';
      const label = action.metadata?.label || `Call ${action.toolName}`;
      const revClass = action.reversibilityClass ? `Class ${action.reversibilityClass}` : 'Unknown';
      output += `  - ${stateIcon} ${label}  (ID: \`${action.id}\`, ${revClass})\n`;
    }
    output += '\n';
  }
  
  output += `To undo changes, call \`undomcp_undo_selection\` with the action IDs or turn IDs you wish to revert.`;
  return output;
}

export function handleListTurns(
  dbManager: DatabaseManager,
  sessionId: string,
  limit: number = 20
): FormattedTurn[] {
  const turns = dbManager.getTurnsForSession(sessionId);
  const actions = dbManager.getActionsForSession(sessionId);
  
  // Sort turns desc, slice by limit
  const sortedTurns = [...turns].sort((a, b) => b.turnNum - a.turnNum).slice(0, limit);
  
  return sortedTurns.map(turn => {
    const turnActions = actions.filter(a => a.turnId === turn.id);
    return {
      id: turn.id,
      turnNum: turn.turnNum,
      promptText: turn.promptText,
      timestamp: turn.timestamp,
      actions: turnActions.map(a => ({
        id: a.id,
        toolName: a.toolName,
        label: a.metadata?.label,
        state: a.state,
        reversibilityClass: a.reversibilityClass
      }))
    };
  });
}

export async function handlePreviewUndo(
  dbManager: DatabaseManager,
  undoController: UndoController,
  sessionId: string,
  actionIds: string[] = [],
  turnIds: string[] = []
): Promise<UndoPreview[]> {
  const resolvedActionIds = resolveActionIds(dbManager, sessionId, actionIds, turnIds);
  return undoController.preview(resolvedActionIds);
}

export async function handleUndoSelection(
  dbManager: DatabaseManager,
  undoController: UndoController,
  sessionId: string,
  actionIds: string[] = [],
  turnIds: string[] = [],
  confirmClassD: boolean = false,
  overwriteConflicts: boolean = false
): Promise<UndoResult[]> {
  const resolvedActionIds = resolveActionIds(dbManager, sessionId, actionIds, turnIds);
  
  const conflictResolver = async (filePath: string) => {
    return overwriteConflicts ? 'overwrite' : 'exit';
  };
  
  const results = await undoController.execute(resolvedActionIds, conflictResolver);
  
  for (const result of results) {
    if (result.outcome === 'requires_confirmation' && confirmClassD) {
      // Bypassing confirmation: mark as undone and return outcome: 'mcp_payload_ready'
      result.outcome = 'mcp_payload_ready';
      
      const payloadParams = result.mcpPayload?.params;
      dbManager.updateActionState(
        result.actionId,
        'undone',
        new Date().toISOString(),
        payloadParams ? { inverseTool: result.mcpPayload?.params.name, inverseParams: result.mcpPayload?.params.arguments } : undefined
      );
    }
  }
  
  return results;
}

function resolveActionIds(
  dbManager: DatabaseManager,
  sessionId: string,
  actionIds: string[],
  turnIds: string[]
): string[] {
  const ids = new Set<string>(actionIds);
  for (const turnId of turnIds) {
    const actions = dbManager.getActionsForTurn(turnId);
    for (const action of actions) {
      ids.add(action.id);
    }
  }
  return Array.from(ids);
}
