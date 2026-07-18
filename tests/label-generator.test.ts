import { describe, it, expect } from 'vitest';
import { generateActionLabel } from '../src/utils/label-generator.js';

describe('generateActionLabel', () => {
  it('labels file tools with path', () => {
    expect(generateActionLabel('write_file', { path: '/tmp/x.ts', content: 'hi' }))
      .toBe('write_file: /tmp/x.ts');
    expect(generateActionLabel('edit_file', { file: 'src/index.ts' }))
      .toBe('edit_file: src/index.ts');
    expect(generateActionLabel('create_directory', { path: '/app/new' }))
      .toBe('create_directory: /app/new');
  });

  it('labels command tools with command text', () => {
    expect(generateActionLabel('run_command', { command: 'npm run build' }))
      .toBe('run_command: npm run build');
    expect(generateActionLabel('execute_command', { CommandLine: 'ls -la' }))
      .toBe('execute_command: ls -la');
  });

  it('extracts top-level title/name/subject', () => {
    expect(generateActionLabel('notion-create-pages', { title: 'My Page' }))
      .toBe('notion-create-pages: "My Page"');
    expect(generateActionLabel('create-issue', { name: 'Bug report' }))
      .toBe('create-issue: "Bug report"');
    expect(generateActionLabel('send-email', { subject: 'Hello World' }))
      .toBe('send-email: "Hello World"');
  });

  it('truncates long titles at 60 chars', () => {
    const longTitle = 'A'.repeat(80);
    const label = generateActionLabel('create-page', { title: longTitle });
    expect(label).toBe(`create-page: "${'A'.repeat(57)}..."`);
  });

  it('extracts from Notion-style nested properties with rich text arrays', () => {
    const args = {
      properties: {
        title: [{ text: { content: 'My Notion Page' } }]
      }
    };
    expect(generateActionLabel('notion-create-pages', args))
      .toBe('notion-create-pages: "My Notion Page"');
  });

  it('extracts from Notion-style property objects with .title array', () => {
    const args = {
      properties: {
        Name: { title: [{ text: { content: 'Task Title' } }] }
      }
    };
    expect(generateActionLabel('notion-create-pages', args))
      .toBe('notion-create-pages: "Task Title"');
  });

  it('extracts from properties with plain_text', () => {
    const args = {
      properties: {
        title: [{ plain_text: 'Quick Note' }]
      }
    };
    expect(generateActionLabel('notion-update-page', args))
      .toBe('notion-update-page: "Quick Note"');
  });

  it('falls back to path-based label', () => {
    expect(generateActionLabel('some-tool', { path: '/data/file.json' }))
      .toBe('some-tool on /data/file.json');
  });

  it('falls back to id-based label', () => {
    expect(generateActionLabel('some-tool', { id: 'abc-123' }))
      .toBe('some-tool (abc-123)');
  });

  it('falls back to generic Call label', () => {
    expect(generateActionLabel('mystery-tool', { foo: 'bar' }))
      .toBe('Call mystery-tool');
  });

  it('handles empty args gracefully', () => {
    expect(generateActionLabel('some-tool', {}))
      .toBe('Call some-tool');
  });
});
