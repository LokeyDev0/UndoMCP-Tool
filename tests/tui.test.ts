import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe.skip('TUI Interactive Checklist (legacy - source removed)', () => {
  let dbManagerMock: any;
  let undoControllerMock: any;
  let writeSpy: any;
  let consoleSpy: any;

  beforeEach(() => {
    // Mock DatabaseManager
    dbManagerMock = {
      getTurnsForSession: vi.fn().mockReturnValue([
        { id: 'turn_1', turnNum: 1, promptText: 'Create a test file', timestamp: '2026-06-06T12:00:00Z' }
      ]),
      getActionsForSession: vi.fn().mockReturnValue([
        { id: 'act_1', turnId: 'turn_1', sequenceNum: 1, timestamp: '2026-06-06T12:00:05Z', actionType: 'file_change', toolName: 'write_file', state: 'executed', metadata: { label: 'Modify file: test.txt' } }
      ]),
      getSnapshot: vi.fn(),
    };

    // Mock UndoController
    undoControllerMock = {
      execute: vi.fn().mockResolvedValue([
        { actionId: 'act_1', success: true, outcome: 'file_restored' }
      ]),
    };

    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    writeSpy.mockRestore();
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('should exit immediately if session has no turns', async () => {
    dbManagerMock.getTurnsForSession.mockReturnValue([]);
    await runTui(dbManagerMock, undoControllerMock, 'session_1');
    expect(writeSpy).not.toHaveBeenCalledWith(expect.stringContaining('UndoMCP Interactive Rollback TUI'));
  });

  it('should render the interactive menu, allow keypresses and execute selections on Enter', async () => {
    const originalIsTTY = process.stdin.isTTY;
    (process.stdin as any).isTTY = true;
    const originalSetRawMode = process.stdin.setRawMode;
    process.stdin.setRawMode = vi.fn();

    // Start runTui in a promise so we can interact with it
    const tuiPromise = runTui(dbManagerMock, undoControllerMock, 'session_1');

    // Wait a brief moment for initial render
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('=== UndoMCP Interactive Rollback TUI ==='));
    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Turn #1: Create a test file'));

    // Move cursor down to action and space-select it
    process.stdin.emit('keypress', null, { name: 'down' });
    process.stdin.emit('keypress', null, { name: 'space' });

    // Press return to execute
    process.stdin.emit('keypress', null, { name: 'return' });

    await tuiPromise;

    expect(undoControllerMock.execute).toHaveBeenCalledWith(['act_1'], expect.any(Function));
    
    const hasSuccessMessage = consoleSpy.mock.calls.some((call: any[]) =>
      call.some((arg) => typeof arg === 'string' && arg.includes('[Restored]') && arg.includes('Modify file: test.txt'))
    );
    expect(hasSuccessMessage).toBe(true);

    // Restore process.stdin
    (process.stdin as any).isTTY = originalIsTTY;
    if (originalSetRawMode) {
      process.stdin.setRawMode = originalSetRawMode;
    }
  });

  it('should toggle selection for all actions under a turn when the turn is selected', async () => {
    const originalIsTTY = process.stdin.isTTY;
    (process.stdin as any).isTTY = true;
    const originalSetRawMode = process.stdin.setRawMode;
    process.stdin.setRawMode = vi.fn();

    const tuiPromise = runTui(dbManagerMock, undoControllerMock, 'session_1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Space-select the turn (cursor starts on turn)
    process.stdin.emit('keypress', null, { name: 'space' });

    // Press return to execute
    process.stdin.emit('keypress', null, { name: 'return' });

    await tuiPromise;

    // The action under the turn should have been selected and executed
    expect(undoControllerMock.execute).toHaveBeenCalledWith(['act_1'], expect.any(Function));

    (process.stdin as any).isTTY = originalIsTTY;
    if (originalSetRawMode) {
      process.stdin.setRawMode = originalSetRawMode;
    }
  });

  it('should allow toggling preview with Tab key', async () => {
    const originalIsTTY = process.stdin.isTTY;
    (process.stdin as any).isTTY = true;
    const originalSetRawMode = process.stdin.setRawMode;
    process.stdin.setRawMode = vi.fn();

    const tuiPromise = runTui(dbManagerMock, undoControllerMock, 'session_1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Press Tab key to open preview
    process.stdin.emit('keypress', null, { name: 'tab' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('--- Preview Panel (Press Tab again to close) ---'));

    // Press escape to exit without executing
    process.stdin.emit('keypress', null, { name: 'escape' });

    await tuiPromise;

    (process.stdin as any).isTTY = originalIsTTY;
    if (originalSetRawMode) {
      process.stdin.setRawMode = originalSetRawMode;
    }
  });
});
