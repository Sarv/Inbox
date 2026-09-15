import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LabelRepository } from '../../../src/repositories/label-repository';
import { newMigratedDb } from '../../../src/test-support/test-db';

// Labels are user-created taxonomy: the row here is the ONLY record that a tag
// name is a label (and what colour it renders in). Losing/duplicating a row
// leaves orphaned `|MyLabel|` tags on mail that the UI can no longer name, so
// the CRUD round-trip, the UNIQUE(name) guard and the colour default all matter.

const FROZEN_MS = Date.parse('2026-08-18T09:15:30.500Z');
const FROZEN_SECONDS = Math.floor(FROZEN_MS / 1000);

describe('LabelRepository', () => {
  let db: Database.Database;
  let repo: LabelRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new LabelRepository(() => db);
    // created_at/updated_at come from Date.now() — freeze it so timestamps are
    // exact assertions instead of "roughly now".
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  it('round-trips a created label through get() with seconds-precision timestamps', () => {
    const created = repo.create({ name: 'Invoices', color: '#ff0000' });

    expect(created).toEqual({
      id: created.id,
      name: 'Invoices',
      color: '#ff0000',
      syncedToServer: false,
      createdAt: FROZEN_SECONDS,
      updatedAt: FROZEN_SECONDS,
    });
    expect(repo.get(created.id)).toEqual(created);
  });

  it('trims whitespace from the name and defaults the colour when none is given', () => {
    // A stray space would make the stored tag `| Receipts |` and never match the
    // tag written onto emails.
    const label = repo.create({ name: '  Receipts  ' });
    expect(label.name).toBe('Receipts');
    expect(label.color).toBe('#2563eb');
  });

  it('records syncedToServer so the UI can tell a server-mirrored label from a local one', () => {
    const local = repo.create({ name: 'Local' });
    const mirrored = repo.create({ name: 'Mirrored' }, true);
    expect(local.syncedToServer).toBe(false);
    expect(mirrored.syncedToServer).toBe(true);
    expect(repo.get(mirrored.id)?.syncedToServer).toBe(true);
  });

  it('falls back to the default colour for a row whose colour is empty (legacy/hand-edited data)', () => {
    const label = repo.create({ name: 'Legacy' });
    db.prepare('UPDATE labels SET color = ? WHERE id = ?').run('', label.id);
    expect(repo.get(label.id)?.color).toBe('#2563eb');
  });

  it('rejects a duplicate name — UNIQUE(name) is what stops two labels owning one tag', () => {
    repo.create({ name: 'Work' });
    expect(() => repo.create({ name: 'Work' })).toThrow();
    expect(repo.list()).toHaveLength(1);
  });

  it('lists labels case-INSENSITIVELY by name so the sidebar order matches what users read', () => {
    repo.create({ name: 'zeta' });
    repo.create({ name: 'Alpha' });
    repo.create({ name: 'beta' });
    expect(repo.list().map((l) => l.name)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('returns an empty list (not null) when no labels exist', () => {
    expect(repo.list()).toEqual([]);
  });

  describe('update', () => {
    it('applies name + colour and bumps updated_at, leaving created_at alone', () => {
      const label = repo.create({ name: 'Old', color: '#111111' });
      vi.setSystemTime(FROZEN_MS + 60_000);

      const updated = repo.update(label.id, { name: ' New ', color: '#222222' });
      expect(updated).toEqual({
        id: label.id,
        name: 'New',
        color: '#222222',
        syncedToServer: false,
        createdAt: FROZEN_SECONDS,
        updatedAt: FROZEN_SECONDS + 60,
      });
    });

    it('preserves existing values for omitted, empty-string and whitespace-only fields', () => {
      // A blank name arriving from the rename dialog must NOT wipe the label.
      const label = repo.create({ name: 'Keep', color: '#abcdef' });
      expect(repo.update(label.id, {})).toMatchObject({ name: 'Keep', color: '#abcdef' });
      expect(repo.update(label.id, { name: '   ' })).toMatchObject({ name: 'Keep' });
      expect(repo.update(label.id, { color: '' })).toMatchObject({ color: '#abcdef' });
    });

    it('returns null for an unknown id and writes nothing', () => {
      repo.create({ name: 'Only' });
      expect(repo.update('does-not-exist', { name: 'Ghost' })).toBeNull();
      expect(repo.list().map((l) => l.name)).toEqual(['Only']);
    });
  });

  describe('delete', () => {
    it('removes only the target label', () => {
      const a = repo.create({ name: 'A' });
      repo.create({ name: 'B' });
      repo.delete(a.id);
      expect(repo.get(a.id)).toBeNull();
      expect(repo.list().map((l) => l.name)).toEqual(['B']);
    });

    it('is a silent no-op for an unknown id (double-click on Delete must not throw)', () => {
      repo.create({ name: 'A' });
      expect(() => repo.delete('nope')).not.toThrow();
      expect(repo.list()).toHaveLength(1);
    });
  });

  it('get() returns null for an unknown id', () => {
    expect(repo.get('missing')).toBeNull();
  });

  it('throws Storage not initialized instead of crashing when the DB is not ready', () => {
    const detached = new LabelRepository(() => undefined as unknown as Database.Database);
    expect(() => detached.list()).toThrow('Storage not initialized');
  });
});
