import { describe, it, expect } from 'vitest';
import { TABLE_COLUMNS, TABLE_SCHEMAS } from './schema';

/** 八张核心表（PRD §6.2）必须包含的字段，用于完备性断言。 */
const CORE_REQUIRED: Record<string, readonly string[]> = {
  memory_item: [
    'id', 'user_id', 'scope', 'project_id', 'feature_id', 'page_id', 'element_id', 'issue_id',
    'title', 'content', 'structured', 'tags', 'source_type', 'source_ref', 'confidence',
    'importance', 'status', 'pinned', 'version', 'created_at', 'updated_at', 'embedding',
  ],
  element: [
    'id', 'page_id', 'parent_id', 'type', 'name', 'props_json', 'style_json',
    'feature_ref', 'note_id', 'order_index', 'anchor_json', 'created_at', 'updated_at',
  ],
  code_anchor: [
    'id', 'project_id', 'element_id', 'page_id', 'feature_id', 'file_path', 'symbol',
    'start_line', 'end_line', 'kind', 'commit_sha', 'created_at', 'updated_at',
  ],
  pipeline_run: [
    'id', 'project_id', 'stage', 'status', 'artifact_type', 'version',
    'content_ref', 'diff_ref', 'created_at', 'updated_at',
  ],
  stage_artifact: [
    'id', 'run_id', 'project_id', 'stage', 'artifact_type', 'version',
    'content_ref', 'diff_ref', 'created_at',
  ],
  registry_entry: [
    'id', 'project_id', 'entity_type', 'entity_id', 'canonical_name', 'projections_json',
    'aliases_json', 'naming_rule_id', 'name_history_json', 'sync_state', 'created_at', 'updated_at',
  ],
  occurrence: [
    'id', 'registry_id', 'kind', 'ref_path', 'locator', 'matched_symbol', 'confidence',
    'risk_level', 'status', 'created_at', 'updated_at',
  ],
  rename_event: [
    'id', 'project_id', 'registry_id', 'old_name', 'new_name', 'changeset_json',
    'scope', 'commit_sha', 'undone', 'created_at',
  ],
};

describe('schema 字段对齐', () => {
  it('每张表的 zod schema 字段集合与 TABLE_COLUMNS 完全一致', () => {
    for (const table of Object.keys(TABLE_COLUMNS) as (keyof typeof TABLE_COLUMNS)[]) {
      const schema = TABLE_SCHEMAS[table];
      expect(schema, `缺少 ${table} 的 schema`).toBeDefined();
      const schemaKeys = Object.keys(schema.shape);
      expect(new Set(schemaKeys)).toEqual(new Set([...TABLE_COLUMNS[table]]));
    }
  });

  it('八张核心表字段完备（逐字段对齐 PRD §6.2）', () => {
    for (const [table, required] of Object.entries(CORE_REQUIRED)) {
      const columns = TABLE_COLUMNS[table as keyof typeof TABLE_COLUMNS];
      expect(columns, `缺少核心表 ${table}`).toBeDefined();
      for (const col of required) {
        expect(columns).toContain(col);
      }
    }
  });
});
