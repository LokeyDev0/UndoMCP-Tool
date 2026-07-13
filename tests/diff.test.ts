import { describe, it, expect } from 'vitest';
import { generateUnifiedDiff, diffLines } from '../src/utils/diff.js';

describe('Unified Diff Utility (diff.ts)', () => {
  it('should return empty string when old and new content are identical', () => {
    const content = 'line 1\nline 2\nline 3';
    const diff = generateUnifiedDiff('test.txt', content, content);
    expect(diff).toBe('');
  });

  it('should generate correct diff for file creation', () => {
    const newContent = 'hello\nworld';
    const diff = generateUnifiedDiff('test.txt', null, newContent);
    
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/test.txt');
    expect(diff).toContain('@@ -0,0 +1,2 @@');
    expect(diff).toContain('+hello');
    expect(diff).toContain('+world');
  });

  it('should generate correct diff for file deletion', () => {
    const oldContent = 'hello\nworld';
    const diff = generateUnifiedDiff('test.txt', oldContent, null);

    expect(diff).toContain('--- a/test.txt');
    expect(diff).toContain('+++ /dev/null');
    expect(diff).toContain('@@ -1,2 +0,0 @@');
    expect(diff).toContain('-hello');
    expect(diff).toContain('-world');
  });

  it('should handle single-line modification with context', () => {
    const oldContent = 'line 1\nline 2\nline 3\nline 4\nline 5';
    const newContent = 'line 1\nline 2\nmodified line 3\nline 4\nline 5';
    const diff = generateUnifiedDiff('test.txt', oldContent, newContent);

    expect(diff).toContain('--- a/test.txt');
    expect(diff).toContain('+++ b/test.txt');
    expect(diff).toContain('@@ -1,5 +1,5 @@');
    expect(diff).toContain(' line 1');
    expect(diff).toContain(' line 2');
    expect(diff).toContain('-line 3');
    expect(diff).toContain('+modified line 3');
    expect(diff).toContain(' line 4');
    expect(diff).toContain(' line 5');
  });

  it('should split into multiple hunks when changes are separated by more than 6 unchanged lines', () => {
    const oldContent = [
      'start',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'line 9',
      'line 10',
      'end'
    ].join('\n');

    const newContent = [
      'start modified',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'line 9',
      'line 10',
      'end modified'
    ].join('\n');

    const diff = generateUnifiedDiff('test.txt', oldContent, newContent);

    // Should contain two separate hunks
    const hunkHeaderCount = (diff.match(/@@/g) || []).length / 2;
    expect(hunkHeaderCount).toBe(2);

    expect(diff).toContain('@@ -1,4 +1,4 @@');
    expect(diff).toContain('@@ -9,4 +9,4 @@');
  });

  it('should merge close changes into a single hunk', () => {
    const oldContent = [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5'
    ].join('\n');

    const newContent = [
      'line 1 modified',
      'line 2',
      'line 3',
      'line 4 modified',
      'line 5'
    ].join('\n');

    const diff = generateUnifiedDiff('test.txt', oldContent, newContent);

    // Changes are close (index 0 and index 3), so they should be in 1 hunk
    const hunkHeaderCount = (diff.match(/@@/g) || []).length / 2;
    expect(hunkHeaderCount).toBe(1);
    expect(diff).toContain('@@ -1,5 +1,5 @@');
  });
});
