import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FilterAction, FilterCondition } from '@sarvinbox/core';

import { newMigratedDb } from '../../../src/test-support/test-db';
import { FilterRepository } from '../../../src/repositories/filter-repository';

// Filter rules mutate incoming mail (mark read, archive, delete, move) so any
// storage bug here silently misfiles or destroys real messages: a rule that
// round-trips with the wrong conditions applies to the wrong mail, a disabled
// rule that comes back enabled starts acting on its own, and a half-applied
// reorder changes which rule wins. Everything below is a real-mail guard.

const FROZEN_MS = Date.parse('2026-08-18T09:15:30.000Z');
const FROZEN_SECONDS = Math.floor(FROZEN_MS / 1000);

const CONDITIONS: FilterCondition[] = [
  { field: 'from', operator: 'contains', value: 'billing@acme.test' },
  { field: 'subject', operator: 'startsWith', value: 'Invoice #' },
];
const ACTIONS: FilterAction[] = [
  { type: 'applyLabel', value: 'Invoices' },
  { type: 'markRead' },
];

describe('FilterRepository', () => {
  let db: Database.Database;
  let repo: FilterRepository;

  beforeEach(() => {
    db = newMigratedDb();
    repo = new FilterRepository(() => db);
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  describe('create', () => {
    it('round-trips conditions/actions JSON EXACTLY (a lossy encode would misfile mail)', () => {
      const rule = repo.create({
        name: 'Acme invoices',
        priority: 7,
        matchType: 'any',
        conditions: CONDITIONS,
        actions: ACTIONS,
        stopProcessing: true,
      });

      expect(rule).toEqual({
        id: rule.id,
        name: 'Acme invoices',
        enabled: true,
        priority: 7,
        matchType: 'any',
        conditions: CONDITIONS,
        actions: ACTIONS,
        stopProcessing: true,
        createdAt: FROZEN_SECONDS,
        updatedAt: FROZEN_SECONDS,
      });
      expect(repo.get(rule.id)).toEqual(rule);
    });

    it('defaults to enabled, priority 0, matchType all, no conditions/actions, no stopProcessing', () => {
      const rule = repo.create({ name: 'Bare', conditions: [], actions: [] });
      expect(rule).toMatchObject({
        enabled: true,
        priority: 0,
        matchType: 'all',
        conditions: [],
        actions: [],
        stopProcessing: false,
      });
    });

    it('stores [] when conditions/actions are missing entirely (a partial payload from the UI)', () => {
      // NOT NULL columns — an undefined here would abort the insert and the new
      // rule would just vanish from the Filters screen.
      const rule = repo.create({ name: 'No arrays' } as unknown as Parameters<typeof repo.create>[0]);
      expect(rule).toMatchObject({ conditions: [], actions: [] });
      expect(db.prepare('SELECT conditions, actions FROM filter_rules WHERE id = ?').get(rule.id))
        .toEqual({ conditions: '[]', actions: '[]' });
    });

    it('honours enabled: false at create time so a rule can be saved without arming it', () => {
      const rule = repo.create({ name: 'Draft rule', enabled: false, conditions: [], actions: [] });
      expect(rule.enabled).toBe(false);
      expect(repo.listEnabled()).toEqual([]);
    });

    it('normalises any matchType that is not exactly "any" down to "all" (fail-closed AND)', () => {
      // A garbage matchType must never mean "match anything" — that would apply
      // the rule's actions to unrelated mail.
      const bogus = repo.create({
        name: 'Bogus match type',
        matchType: 'ANY' as unknown as 'any',
        conditions: CONDITIONS,
        actions: ACTIONS,
      });
      expect(bogus.matchType).toBe('all');
      expect(db.prepare('SELECT match_type FROM filter_rules WHERE id = ?').get(bogus.id))
        .toEqual({ match_type: 'all' });
    });
  });

  describe('list / listEnabled', () => {
    it('orders by priority DESC then creation order, and listEnabled drops disabled rules', () => {
      // This IS the evaluation order — get it wrong and a low-priority delete
      // rule can run before the label rule that was supposed to win.
      const low = repo.create({ name: 'low', priority: 1, conditions: [], actions: [] });
      vi.setSystemTime(FROZEN_MS + 1000);
      const highOld = repo.create({ name: 'high-old', priority: 9, conditions: [], actions: [] });
      vi.setSystemTime(FROZEN_MS + 2000);
      const highNew = repo.create({ name: 'high-new', priority: 9, conditions: [], actions: [] });
      vi.setSystemTime(FROZEN_MS + 3000);
      const off = repo.create({ name: 'off', priority: 5, enabled: false, conditions: [], actions: [] });

      expect(repo.list().map((r) => r.id)).toEqual([highOld.id, highNew.id, off.id, low.id]);
      expect(repo.listEnabled().map((r) => r.id)).toEqual([highOld.id, highNew.id, low.id]);
    });

    it('returns empty arrays when there are no rules', () => {
      expect(repo.list()).toEqual([]);
      expect(repo.listEnabled()).toEqual([]);
    });
  });

  describe('mapRow resilience', () => {
    it('degrades a CORRUPT conditions/actions blob to [] instead of throwing the list away', () => {
      // One bad row (partial write, hand-edited DB) must not take down the whole
      // Filters screen or the ingest pipeline that lists rules.
      const rule = repo.create({ name: 'Corrupt', conditions: CONDITIONS, actions: ACTIONS });
      db.prepare('UPDATE filter_rules SET conditions = ?, actions = ? WHERE id = ?')
        .run('{not json', '', rule.id);

      const loaded = repo.get(rule.id);
      expect(loaded).toMatchObject({ conditions: [], actions: [] });
      expect(repo.list()).toHaveLength(1);
    });

    it('reads a legacy/hand-written match_type of anything-but-"any" as "all"', () => {
      const rule = repo.create({ name: 'Legacy', conditions: [], actions: [] });
      db.prepare('UPDATE filter_rules SET match_type = ? WHERE id = ?').run('weird', rule.id);
      expect(repo.get(rule.id)?.matchType).toBe('all');
    });
  });

  describe('update', () => {
    it('merges only the supplied fields and bumps updated_at, keeping created_at', () => {
      const rule = repo.create({
        name: 'Original', priority: 3, matchType: 'any', conditions: CONDITIONS, actions: ACTIONS, stopProcessing: true,
      });
      vi.setSystemTime(FROZEN_MS + 120_000);

      const updated = repo.update(rule.id, { name: 'Renamed' });
      expect(updated).toEqual({
        ...rule,
        name: 'Renamed',
        updatedAt: FROZEN_SECONDS + 120,
      });
    });

    it('persists enabled: false — ?? must not treat false as "omitted"', () => {
      // The classic `||` bug here would silently re-arm a rule the user just
      // switched off, and it would start acting on incoming mail again.
      const rule = repo.create({ name: 'Armed', conditions: [], actions: [] });
      expect(repo.update(rule.id, { enabled: false })?.enabled).toBe(false);
      expect(repo.listEnabled()).toEqual([]);
      // ...and an untouched update keeps it disabled.
      expect(repo.update(rule.id, { name: 'Still off' })?.enabled).toBe(false);
    });

    it('persists priority 0 and stopProcessing false (other falsy values that must survive)', () => {
      const rule = repo.create({ name: 'Falsy', priority: 5, stopProcessing: true, conditions: [], actions: [] });
      const updated = repo.update(rule.id, { priority: 0, stopProcessing: false });
      expect(updated).toMatchObject({ priority: 0, stopProcessing: false });
    });

    it('replaces conditions/actions wholesale, including clearing them to []', () => {
      const rule = repo.create({ name: 'Swap', conditions: CONDITIONS, actions: ACTIONS });
      const next: FilterCondition[] = [{ field: 'domain', operator: 'equals', value: 'acme.test' }];
      expect(repo.update(rule.id, { conditions: next })?.conditions).toEqual(next);
      expect(repo.update(rule.id, { actions: [] })?.actions).toEqual([]);
      expect(repo.get(rule.id)?.conditions).toEqual(next);   // unrelated field untouched
    });

    it('re-normalises matchType on update too', () => {
      const rule = repo.create({ name: 'Norm', matchType: 'any', conditions: [], actions: [] });
      expect(repo.update(rule.id, { matchType: 'nonsense' as unknown as 'all' })?.matchType).toBe('all');
      expect(repo.update(rule.id, { matchType: 'any' })?.matchType).toBe('any');
    });

    it('returns null for an unknown id and leaves every stored rule untouched', () => {
      const rule = repo.create({ name: 'Only', priority: 2, conditions: CONDITIONS, actions: ACTIONS });
      expect(repo.update('ghost-id', { name: 'Hacked', priority: 99 })).toBeNull();
      expect(repo.get(rule.id)).toMatchObject({ name: 'Only', priority: 2 });
      expect(repo.list()).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('removes only the target rule and is a no-op for an unknown id', () => {
      const a = repo.create({ name: 'A', conditions: [], actions: [] });
      vi.setSystemTime(FROZEN_MS + 1000);
      const b = repo.create({ name: 'B', conditions: [], actions: [] });

      repo.delete(a.id);
      expect(repo.get(a.id)).toBeNull();
      expect(repo.list().map((r) => r.id)).toEqual([b.id]);

      expect(() => repo.delete('never-existed')).not.toThrow();
      expect(repo.list()).toHaveLength(1);
    });
  });

  describe('reorder', () => {
    it('assigns descending priorities top-to-bottom so the first id evaluates first', () => {
      const a = repo.create({ name: 'A', conditions: [], actions: [] });
      vi.setSystemTime(FROZEN_MS + 1000);
      const b = repo.create({ name: 'B', conditions: [], actions: [] });
      vi.setSystemTime(FROZEN_MS + 2000);
      const c = repo.create({ name: 'C', conditions: [], actions: [] });

      repo.reorder([c.id, a.id, b.id]);

      expect(repo.get(c.id)?.priority).toBe(3);
      expect(repo.get(a.id)?.priority).toBe(2);
      expect(repo.get(b.id)?.priority).toBe(1);
      // list() is ordered by priority DESC, so it now mirrors the drag order.
      expect(repo.list().map((r) => r.id)).toEqual([c.id, a.id, b.id]);
    });

    it('ignores ids that no longer exist (a rule deleted in another window)', () => {
      const a = repo.create({ name: 'A', conditions: [], actions: [] });
      expect(() => repo.reorder(['gone', a.id])).not.toThrow();
      expect(repo.get(a.id)?.priority).toBe(1);
    });

    it('is ATOMIC — a mid-way failure leaves every priority at its old value', () => {
      // Without the single transaction the list would persist half-reordered:
      // two rules claiming the same priority, so which one wins becomes random.
      const a = repo.create({ name: 'A', priority: 10, conditions: [], actions: [] });
      const b = repo.create({ name: 'B', priority: 20, conditions: [], actions: [] });
      const c = repo.create({ name: 'C', priority: 30, conditions: [], actions: [] });

      // Make the LAST write in the batch fail, after the first two succeeded.
      db.exec(`
        CREATE TRIGGER block_c BEFORE UPDATE ON filter_rules
        WHEN NEW.id = '${c.id}'
        BEGIN SELECT RAISE(ABORT, 'blocked'); END;
      `);

      expect(() => repo.reorder([a.id, b.id, c.id])).toThrow();

      expect(repo.get(a.id)?.priority).toBe(10);
      expect(repo.get(b.id)?.priority).toBe(20);
      expect(repo.get(c.id)?.priority).toBe(30);
    });

    it('accepts an empty ordering without touching anything', () => {
      const a = repo.create({ name: 'A', priority: 4, conditions: [], actions: [] });
      repo.reorder([]);
      expect(repo.get(a.id)?.priority).toBe(4);
    });
  });

  it('get() returns null for an unknown id', () => {
    expect(repo.get('missing')).toBeNull();
  });
});
