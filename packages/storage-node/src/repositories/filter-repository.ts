// Filter Repository - CRUD for user-defined inbox filter rules

import { generateId, type FilterRule, type FilterRuleInput } from '@sarvinbox/core';

import { BaseRepository } from './base-repository';

export class FilterRepository extends BaseRepository {
  private mapRow(row: any): FilterRule {
    return {
      id: row.id,
      name: row.name,
      enabled: row.enabled === 1,
      priority: row.priority,
      matchType: row.match_type === 'any' ? 'any' : 'all',
      conditions: this.parseJsonField(row.conditions, []),
      actions: this.parseJsonField(row.actions, []),
      stopProcessing: row.stop_processing === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): FilterRule[] {
    const rows = this.db
      .prepare('SELECT * FROM filter_rules ORDER BY priority DESC, created_at ASC')
      .all() as any[];
    return rows.map((r) => this.mapRow(r));
  }

  listEnabled(): FilterRule[] {
    const rows = this.db
      .prepare('SELECT * FROM filter_rules WHERE enabled = 1 ORDER BY priority DESC, created_at ASC')
      .all() as any[];
    return rows.map((r) => this.mapRow(r));
  }

  get(id: string): FilterRule | null {
    const row = this.db.prepare('SELECT * FROM filter_rules WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  create(input: FilterRuleInput): FilterRule {
    const id = generateId();
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO filter_rules
           (id, name, enabled, priority, match_type, conditions, actions, stop_processing, created_at, updated_at)
         VALUES
           (@id, @name, @enabled, @priority, @matchType, @conditions, @actions, @stopProcessing, @createdAt, @updatedAt)`
      )
      .run({
        id,
        name: input.name,
        enabled: input.enabled === false ? 0 : 1,
        priority: input.priority ?? 0,
        matchType: input.matchType === 'any' ? 'any' : 'all',
        conditions: JSON.stringify(input.conditions ?? []),
        actions: JSON.stringify(input.actions ?? []),
        stopProcessing: input.stopProcessing ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });
    return this.get(id)!;
  }

  update(id: string, updates: Partial<FilterRuleInput>): FilterRule | null {
    const existing = this.get(id);
    if (!existing) return null;
    // `?? existing` preserves fields the caller omits; note `enabled: false`
    // survives because ?? only falls through on null/undefined.
    const merged = {
      name: updates.name ?? existing.name,
      enabled: updates.enabled ?? existing.enabled,
      priority: updates.priority ?? existing.priority,
      matchType: updates.matchType ?? existing.matchType,
      conditions: updates.conditions ?? existing.conditions,
      actions: updates.actions ?? existing.actions,
      stopProcessing: updates.stopProcessing ?? existing.stopProcessing,
    };
    this.db
      .prepare(
        `UPDATE filter_rules SET
           name = @name, enabled = @enabled, priority = @priority, match_type = @matchType,
           conditions = @conditions, actions = @actions, stop_processing = @stopProcessing, updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id,
        name: merged.name,
        enabled: merged.enabled ? 1 : 0,
        priority: merged.priority,
        matchType: merged.matchType === 'any' ? 'any' : 'all',
        conditions: JSON.stringify(merged.conditions),
        actions: JSON.stringify(merged.actions),
        stopProcessing: merged.stopProcessing ? 1 : 0,
        updatedAt: this.now(),
      });
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM filter_rules WHERE id = ?').run(id);
  }

  /**
   * Reassign priorities from a top-to-bottom ordering of rule ids. The first id
   * gets the highest priority (so it evaluates first). Done in one transaction
   * so the list never persists a half-reordered state.
   */
  reorder(orderedIds: string[]): void {
    const stmt = this.db.prepare('UPDATE filter_rules SET priority = ?, updated_at = unixepoch() WHERE id = ?');
    const tx = this.db.transaction((ids: string[]) => {
      ids.forEach((id, index) => {
        stmt.run(ids.length - index, id);
      });
    });
    tx(orderedIds);
  }
}
