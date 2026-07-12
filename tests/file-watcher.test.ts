import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe.skip('WorkspaceFileWatcher (legacy - source removed)', () => {
  let tempWorkspacePath: string;

  beforeEach(() => {
    const tempDir = os.tmpdir();
    tempWorkspacePath = fs.mkdtempSync(path.join(tempDir, 'undomcp_watcher_test_'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempWorkspacePath)) {
        fs.rmSync(tempWorkspacePath, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('Failed to clean up temporary workspace', err);
    }
  });

  it('should detect file creation, modification, and deletion', async () => {
    const onEvents = vi.fn();
    const watcher = new WorkspaceFileWatcher({
      workspacePath: tempWorkspacePath,
      onEvents,
      debounceMs: 50
    });

    await watcher.start();

    // 1. Create a file
    const testFile = path.join(tempWorkspacePath, 'test.txt');
    fs.writeFileSync(testFile, 'initial content');

    // Wait for event to trigger and debounce (50ms stabilityThreshold + 50ms debounceMs + 100ms safety buffer)
    await new Promise(r => setTimeout(r, 200));
    expect(onEvents).toHaveBeenCalledTimes(1);
    expect(onEvents.mock.calls[0][0][0]).toEqual(expect.objectContaining({
      path: path.resolve(testFile),
      type: 'create'
    }));

    // 2. Modify the file
    fs.writeFileSync(testFile, 'modified content');

    await new Promise(r => setTimeout(r, 200));
    expect(onEvents).toHaveBeenCalledTimes(2);
    expect(onEvents.mock.calls[1][0][0]).toEqual(expect.objectContaining({
      path: path.resolve(testFile),
      type: 'modify'
    }));

    // 3. Delete the file
    fs.unlinkSync(testFile);

    await new Promise(r => setTimeout(r, 200));
    expect(onEvents).toHaveBeenCalledTimes(3);
    expect(onEvents.mock.calls[2][0][0]).toEqual(expect.objectContaining({
      path: path.resolve(testFile),
      type: 'delete'
    }));

    await watcher.stop();
  });

  it('should ignore files matched by the root .gitignore and defaults', async () => {
    // Write a root .gitignore file
    fs.writeFileSync(path.join(tempWorkspacePath, '.gitignore'), `
# Comments are ignored
*.log
ignored_dir/
    `);

    const onEvents = vi.fn();
    const watcher = new WorkspaceFileWatcher({
      workspacePath: tempWorkspacePath,
      onEvents,
      debounceMs: 50
    });

    expect(watcher.isIgnored(path.join(tempWorkspacePath, 'debug.log'))).toBe(true);
    expect(watcher.isIgnored(path.join(tempWorkspacePath, 'ignored_dir/file.txt'))).toBe(true);
    expect(watcher.isIgnored(path.join(tempWorkspacePath, 'node_modules/some-pkg/index.js'))).toBe(true);
    expect(watcher.isIgnored(path.join(tempWorkspacePath, '.git/config'))).toBe(true);
    expect(watcher.isIgnored(path.join(tempWorkspacePath, 'src/main.ts'))).toBe(false);

    await watcher.start();

    // Create a file that is ignored
    fs.writeFileSync(path.join(tempWorkspacePath, 'debug.log'), 'log info');
    fs.mkdirSync(path.join(tempWorkspacePath, 'ignored_dir'));
    fs.writeFileSync(path.join(tempWorkspacePath, 'ignored_dir/file.txt'), 'secret');
    
    // Create a non-ignored file
    fs.writeFileSync(path.join(tempWorkspacePath, 'normal.txt'), 'hello');

    await new Promise(r => setTimeout(r, 200));
    
    expect(onEvents).toHaveBeenCalledTimes(1);
    expect(onEvents.mock.calls[0][0].length).toBe(1);
    expect(onEvents.mock.calls[0][0][0].path).toBe(path.resolve(path.join(tempWorkspacePath, 'normal.txt')));

    await watcher.stop();
  });

  it('should debounce rapid changes and collapse transient events', async () => {
    const onEvents = vi.fn();
    const watcher = new WorkspaceFileWatcher({
      workspacePath: tempWorkspacePath,
      onEvents,
      debounceMs: 100
    });

    await watcher.start();

    const fileA = path.join(tempWorkspacePath, 'fileA.txt');
    const fileB = path.join(tempWorkspacePath, 'fileB.txt');

    fs.writeFileSync(fileA, 'hello');
    fs.writeFileSync(fileB, 'world');

    await new Promise(r => setTimeout(r, 30));
    expect(onEvents).not.toHaveBeenCalled();

    fs.writeFileSync(fileA, 'hello updated');

    // Wait for full debounce window (50ms stabilityThreshold + 100ms debounceMs + 100ms safety buffer)
    await new Promise(r => setTimeout(r, 250));
    
    expect(onEvents).toHaveBeenCalledTimes(1);
    const events = onEvents.mock.calls[0][0];
    expect(events.length).toBe(2);

    const eventA = events.find((e: any) => e.path === path.resolve(fileA));
    const eventB = events.find((e: any) => e.path === path.resolve(fileB));

    expect(eventA).toBeDefined();
    expect(eventA.type).toBe('create');

    expect(eventB).toBeDefined();
    expect(eventB.type).toBe('create');

    await watcher.stop();
  });
});
