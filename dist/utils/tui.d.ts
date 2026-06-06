import { DatabaseManager } from '../journal/database-manager.js';
import { UndoController } from '../undo/undo-controller.js';
export declare function runTui(dbManager: DatabaseManager, undoController: UndoController, sessionId: string): Promise<void>;
