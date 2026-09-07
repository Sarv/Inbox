// Label Repository - CRUD for user-defined labels

import { generateId, type Label, type LabelInput } from '@sarvinbox/core';

import { BaseRepository } from './base-repository';

const DEFAULT_COLOR = '#2563eb';

export class LabelRepository extends BaseRepository {
  private mapRow(row: any): Label {
    return {
      id: row.id,
      name: row.name,
      color: row.color || DEFAULT_COLOR,
      syncedToServer: !!row.synced_to_server,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  list(): Label[] {
    const rows = this.db
      .prepare('SELECT * FROM labels ORDER BY name COLLATE NOCASE ASC')
      .all() as any[];
    return rows.map((r) => this.mapRow(r));
  }

  get(id: string): Label | null {
    const row = this.db.prepare('SELECT * FROM labels WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  create(input: LabelInput, syncedToServer = false): Label {
    const id = generateId();
    const now = this.now();
    this.db
      .prepare('INSERT INTO labels (id, name, color, synced_to_server, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.name.trim(), input.color || DEFAULT_COLOR, syncedToServer ? 1 : 0, now, now);
    return this.get(id)!;
  }

  update(id: string, updates: Partial<LabelInput>): Label | null {
    const existing = this.get(id);
    if (!existing) return null;
    const name = updates.name?.trim() || existing.name;
    const color = updates.color || existing.color;
    this.db
      .prepare('UPDATE labels SET name = ?, color = ?, updated_at = ? WHERE id = ?')
      .run(name, color, this.now(), id);
    return this.get(id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM labels WHERE id = ?').run(id);
  }
}
