import { describe, it, expect } from 'vitest';
import { extractBaseToolName, isReadOnlyTool, shouldRecordTool, NATIVE_TOOLS } from '../src/utils/tool-filter.js';

describe('extractBaseToolName', () => {
  it('handles raw base names unchanged', () => {
    expect(extractBaseToolName('create-page')).toBe('create-page');
    expect(extractBaseToolName('get_comments')).toBe('get_comments');
  });

  it('strips namespace__ prefix', () => {
    expect(extractBaseToolName('notion__create-pages')).toBe('create-pages');
    expect(extractBaseToolName('github__create_issue')).toBe('create_issue');
  });

  it('strips mcp__server__tool prefix', () => {
    // namespace is extracted as 'notion', then 'notion-' prefix is also stripped from tool name
    expect(extractBaseToolName('mcp__notion__notion-create-pages')).toBe('create-pages');
    expect(extractBaseToolName('mcp__github__create_issue')).toBe('create_issue');
  });

  it('strips API- prefix', () => {
    expect(extractBaseToolName('API-post-page')).toBe('post-page');
    expect(extractBaseToolName('API-get-self')).toBe('get-self');
    expect(extractBaseToolName('api-create-item')).toBe('create-item');
  });

  it('strips server name from tool name when namespace provided', () => {
    expect(extractBaseToolName('notion-create-pages', 'notion')).toBe('create-pages');
    expect(extractBaseToolName('notion-get-comments', 'notion')).toBe('get-comments');
    expect(extractBaseToolName('blender_create_object', 'blender')).toBe('create_object');
  });

  it('strips server name baked into mcp__ tool after full prefix strip', () => {
    // With explicit namespace arg: same result
    expect(extractBaseToolName('mcp__notion__notion-create-pages', 'notion')).toBe('create-pages');
    // Without explicit namespace: namespace extracted from mcp__notion__ part, then 'notion-' stripped too
    expect(extractBaseToolName('mcp__notion__notion-get-comments')).toBe('get-comments');
  });

  it('returns empty string for empty input', () => {
    expect(extractBaseToolName('')).toBe('');
    expect(extractBaseToolName('  ')).toBe('');
  });
});

describe('isReadOnlyTool', () => {
  // Core read-only prefixes
  it('identifies get-* as read-only', () => {
    expect(isReadOnlyTool('get-comments')).toBe(true);
    expect(isReadOnlyTool('get_users')).toBe(true);
    expect(isReadOnlyTool('get')).toBe(true);
  });

  it('identifies list-* as read-only', () => {
    expect(isReadOnlyTool('list-pages')).toBe(true);
    expect(isReadOnlyTool('list_repositories')).toBe(true);
  });

  it('identifies search/query/find as read-only', () => {
    expect(isReadOnlyTool('search')).toBe(true);
    expect(isReadOnlyTool('search-issues')).toBe(true);
    expect(isReadOnlyTool('query-database')).toBe(true);
    expect(isReadOnlyTool('find-user')).toBe(true);
  });

  it('identifies fetch/read/lookup as read-only', () => {
    expect(isReadOnlyTool('fetch-resource')).toBe(true);
    expect(isReadOnlyTool('read-file')).toBe(true);
    expect(isReadOnlyTool('lookup-record')).toBe(true);
  });

  it('identifies describe/check/view/show/info/status/count as read-only', () => {
    expect(isReadOnlyTool('describe-instance')).toBe(true);
    expect(isReadOnlyTool('check-status')).toBe(true);
    expect(isReadOnlyTool('view-logs')).toBe(true);
    expect(isReadOnlyTool('show-diff')).toBe(true);
    expect(isReadOnlyTool('info')).toBe(true);
    expect(isReadOnlyTool('status')).toBe(true);
    expect(isReadOnlyTool('count-items')).toBe(true);
  });

  it('identifies retrieve/browse/inspect as read-only', () => {
    expect(isReadOnlyTool('retrieve-a-page')).toBe(true);
    expect(isReadOnlyTool('browse-directory')).toBe(true);
    expect(isReadOnlyTool('inspect-object')).toBe(true);
  });

  it('identifies diagnostic/identity tools as read-only', () => {
    expect(isReadOnlyTool('ping')).toBe(true);
    expect(isReadOnlyTool('health')).toBe(true);
    expect(isReadOnlyTool('version')).toBe(true);
    expect(isReadOnlyTool('whoami')).toBe(true);
    expect(isReadOnlyTool('echo')).toBe(true);
  });

  it('identifies HTTP-verb + read-only noun as read-only', () => {
    expect(isReadOnlyTool('post-search')).toBe(true);
    expect(isReadOnlyTool('post_query')).toBe(true);
    expect(isReadOnlyTool('put-list')).toBe(true);
  });

  // Mutations should NOT be read-only
  it('does not flag create/update/delete as read-only', () => {
    expect(isReadOnlyTool('create-page')).toBe(false);
    expect(isReadOnlyTool('update-record')).toBe(false);
    expect(isReadOnlyTool('delete-block')).toBe(false);
    expect(isReadOnlyTool('insert-row')).toBe(false);
    expect(isReadOnlyTool('post-page')).toBe(false);
    expect(isReadOnlyTool('patch-page')).toBe(false);
    expect(isReadOnlyTool('move-page')).toBe(false);
    expect(isReadOnlyTool('send-message')).toBe(false);
    expect(isReadOnlyTool('upload-file')).toBe(false);
    expect(isReadOnlyTool('run-pipeline')).toBe(false);
    expect(isReadOnlyTool('execute-code')).toBe(false);
  });

  // Edge cases: prefix must be a word boundary
  it('does not flag tools where prefix appears mid-word', () => {
    expect(isReadOnlyTool('forget-password')).toBe(false);  // not get-*
    expect(isReadOnlyTool('checkout')).toBe(false);          // not check-*
    expect(isReadOnlyTool('counter-reset')).toBe(false);     // not count-*
  });

  // Mutation overrides
  it('treats get-or-create as a mutation', () => {
    expect(isReadOnlyTool('get-or-create-page')).toBe(false);
    expect(isReadOnlyTool('find-or-create-user')).toBe(false);
    expect(isReadOnlyTool('get-or-insert-record')).toBe(false);
    expect(isReadOnlyTool('read-or-update-config')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isReadOnlyTool('')).toBe(false);
  });
});

describe('shouldRecordTool', () => {
  it('records state-changing MCP tools', () => {
    // Notion MCP (stdio, mcp__ prefix)
    expect(shouldRecordTool('mcp__notion__notion-create-pages')).toBe(true);
    expect(shouldRecordTool('mcp__notion__notion-update-page')).toBe(true);
    expect(shouldRecordTool('mcp__notion__notion-move-pages')).toBe(true);

    // GitHub MCP
    expect(shouldRecordTool('github__create_issue')).toBe(true);
    expect(shouldRecordTool('github__push_files')).toBe(true);
    expect(shouldRecordTool('github__merge_pull_request')).toBe(true);

    // Blender MCP
    expect(shouldRecordTool('blender__create_object')).toBe(true);
    expect(shouldRecordTool('blender__delete_object')).toBe(true);
    expect(shouldRecordTool('blender__apply_material')).toBe(true);

    // Filesystem MCP
    expect(shouldRecordTool('filesystem__write_file')).toBe(true);
    expect(shouldRecordTool('filesystem__create_directory')).toBe(true);
    expect(shouldRecordTool('filesystem__delete_file')).toBe(true);

    // Slack MCP
    expect(shouldRecordTool('slack__send_message')).toBe(true);
    expect(shouldRecordTool('slack__update_message')).toBe(true);

    // Docker MCP
    expect(shouldRecordTool('docker__create_container')).toBe(true);
    expect(shouldRecordTool('docker__start_container')).toBe(true);
    expect(shouldRecordTool('docker__stop_container')).toBe(true);

    // Database MCPs
    expect(shouldRecordTool('postgres__insert_record')).toBe(true);
    expect(shouldRecordTool('supabase__upsert_rows')).toBe(true);

    // Raw HTTP proxy tool names (no namespace prefix)
    expect(shouldRecordTool('create-page', 'notion')).toBe(true);
    expect(shouldRecordTool('update-database', 'notion')).toBe(true);
  });

  it('skips read-only MCP tools', () => {
    // Notion read-only
    expect(shouldRecordTool('mcp__notion__notion-get-comments')).toBe(false);
    expect(shouldRecordTool('mcp__notion__notion-search')).toBe(false);
    expect(shouldRecordTool('mcp__notion__notion-query-database-view')).toBe(false);

    // GitHub read-only
    expect(shouldRecordTool('github__get_repository')).toBe(false);
    expect(shouldRecordTool('github__list_commits')).toBe(false);
    expect(shouldRecordTool('github__search_repositories')).toBe(false);

    // Blender read-only
    expect(shouldRecordTool('blender__get_scene_info')).toBe(false);
    expect(shouldRecordTool('blender__list_objects')).toBe(false);

    // Filesystem read-only
    expect(shouldRecordTool('filesystem__read_file')).toBe(false);
    expect(shouldRecordTool('filesystem__list_directory')).toBe(false);

    // Brave Search
    expect(shouldRecordTool('brave__search')).toBe(false);
    expect(shouldRecordTool('brave__fetch-page')).toBe(false);

    // Puppeteer/browser read-only
    expect(shouldRecordTool('puppeteer__get_content')).toBe(false);
    expect(shouldRecordTool('puppeteer__find_element')).toBe(false);

    // Memory MCP reads
    expect(shouldRecordTool('memory__retrieve-memories')).toBe(false);
    expect(shouldRecordTool('memory__search_nodes')).toBe(false);

    // HTTP proxy with namespace
    expect(shouldRecordTool('get-comments', 'notion')).toBe(false);
    expect(shouldRecordTool('list-users', 'slack')).toBe(false);
  });

  it('skips native IDE tools', () => {
    expect(shouldRecordTool('Bash')).toBe(false);
    expect(shouldRecordTool('bash')).toBe(false);
    expect(shouldRecordTool('Edit')).toBe(false);
    expect(shouldRecordTool('Write')).toBe(false);
    expect(shouldRecordTool('Read')).toBe(false);
    expect(shouldRecordTool('Glob')).toBe(false);
    expect(shouldRecordTool('Grep')).toBe(false);
    expect(shouldRecordTool('WebFetch')).toBe(false);
    expect(shouldRecordTool('WebSearch')).toBe(false);
  });

  it('skips undomcp own tools', () => {
    expect(shouldRecordTool('undomcp_list_history')).toBe(false);
    expect(shouldRecordTool('undomcp_undo_action')).toBe(false);
    expect(shouldRecordTool('mcp__undomcp__undomcp_mark_turn')).toBe(false);
  });

  it('records mutation overrides like get-or-create', () => {
    expect(shouldRecordTool('get-or-create-page', 'notion')).toBe(true);
    expect(shouldRecordTool('notion__find-or-create-user')).toBe(true);
  });

  it('returns false for empty tool name', () => {
    expect(shouldRecordTool('')).toBe(false);
    expect(shouldRecordTool('', 'notion')).toBe(false);
  });

  it('records unknown/ambiguous tools (conservative)', () => {
    expect(shouldRecordTool('do-something')).toBe(true);
    expect(shouldRecordTool('mystery__custom_action')).toBe(true);
    expect(shouldRecordTool('run-pipeline')).toBe(true);
    expect(shouldRecordTool('trigger-workflow')).toBe(true);
    expect(shouldRecordTool('download-file')).toBe(true);
  });
});

describe('NATIVE_TOOLS', () => {
  it('contains expected native tool names (lowercase)', () => {
    expect(NATIVE_TOOLS.has('bash')).toBe(true);
    expect(NATIVE_TOOLS.has('edit')).toBe(true);
    expect(NATIVE_TOOLS.has('write')).toBe(true);
    expect(NATIVE_TOOLS.has('read')).toBe(true);
  });
});
