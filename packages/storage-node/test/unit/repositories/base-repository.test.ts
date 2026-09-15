import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BaseRepository, type DatabaseAccessor } from '../../../src/repositories/base-repository';
import { setSlowQueryReporter, type SlowQueryEvent } from '../../../src/slow-query-reporter';
import { newMigratedDb, openTestDb } from '../../../src/test-support/test-db';

// BaseRepository is the shared plumbing under EVERY repository, so a bug here is
// a bug everywhere: safeOrderBy is the only thing standing between a
// caller-supplied sort key and raw SQL interpolation, buildUpdateClauses decides
// which columns an UPDATE touches (a wrongly-included `undefined` would NULL out
// real user data), and parseJsonField is what stops one corrupt JSON blob from
// throwing a whole list query. Every member is protected, so a local subclass is
// the only way to exercise them.
class Probe extends BaseRepository {
  constructor(accessor: DatabaseAccessor) {
    super(accessor);
  }

  get database(): Database.Database {
    return this.db;
  }

  toSnake(str: string): string {
    return this.camelToSnake(str);
  }

  orderBy(sortBy: string | undefined, sortOrder: string | undefined, allowed: ReadonlySet<string>, fallback: string) {
    return this.safeOrderBy(sortBy, sortOrder, allowed, fallback);
  }

  toCamelObject<T>(row: Record<string, unknown>): T {
    return this.snakeToCamelObject<T>(row);
  }

  updateClauses(updates: Record<string, unknown>, options?: { jsonFields?: string[]; boolFields?: string[] }) {
    return this.buildUpdateClauses(updates, options);
  }

  json<T>(value: string | null | undefined, fallback: T): T {
    return this.parseJsonField<T>(value, fallback);
  }

  nowSeconds(): number {
    return this.now();
  }

  emailKey(email: string): string {
    return this.normalizeEmailKey(email);
  }

  like(value: string): string {
    return this.likeContains(value);
  }

  measure<T>(label: string, run: () => T, meta?: Record<string, unknown>): T {
    return this.timed(label, run, meta);
  }
}

describe('BaseRepository.db accessor', () => {
  // Every repository method funnels through this getter. During main-process
  // restarts the accessor legitimately returns nothing; it must throw a clear
  // 'Storage not initialized' instead of a cryptic "cannot read prepare of
  // undefined" deep inside a query.
  it('throws Storage not initialized when the accessor yields no database', () => {
    const probe = new Probe(() => undefined as unknown as Database.Database);
    expect(() => probe.database).toThrow('Storage not initialized');
  });

  it('returns the live database when the accessor provides one', () => {
    const db = openTestDb();
    const probe = new Probe(() => db);
    expect(probe.database).toBe(db);
    db.close();
  });
});

describe('camelToSnake', () => {
  // Column-name mapping: getting this wrong writes to a column that doesn't
  // exist (SQLite error) or silently sorts by the wrong field.
  it('lowercases and underscores every capital, and leaves snake_case untouched', () => {
    const probe = new Probe(() => undefined as unknown as Database.Database);
    expect(probe.toSnake('fromAddress')).toBe('from_address');
    expect(probe.toSnake('receivedDate')).toBe('received_date');
    expect(probe.toSnake('already_snake')).toBe('already_snake');
    expect(probe.toSnake('')).toBe('');
    // Consecutive capitals become one underscore EACH — pinning the real
    // behaviour so nobody "fixes" a caller by passing an acronym-y key.
    expect(probe.toSnake('emailID')).toBe('email_i_d');
    // A leading capital produces a leading underscore (never a valid column).
    expect(probe.toSnake('Subject')).toBe('_subject');
  });
});

describe('safeOrderBy', () => {
  const allowed = new Set(['date', 'received_date', 'subject', 'from_address']);
  const probe = new Probe(() => undefined as unknown as Database.Database);

  // sortBy is INTERPOLATED into SQL (it cannot be bound as a parameter), so the
  // whitelist is the actual injection defence for every sortable list/search.
  it('accepts whitelisted columns and maps camelCase input onto them', () => {
    expect(probe.orderBy('subject', 'asc', allowed, 'date')).toEqual({ column: 'subject', direction: 'ASC' });
    expect(probe.orderBy('receivedDate', 'desc', allowed, 'date')).toEqual({ column: 'received_date', direction: 'DESC' });
  });

  // The public query types offer sort keys that are not column names. `'from'`
  // camel-maps to `from`, which is not a column (`from_address` is), so it fell
  // off the whitelist and "sort by sender" silently sorted by date.
  it('resolves the public sort aliases onto their real columns', () => {
    expect(probe.orderBy('from', 'asc', allowed, 'date')).toEqual({ column: 'from_address', direction: 'ASC' });
    expect(probe.orderBy('sender', 'desc', allowed, 'date').column).toBe('from_address');
    // An alias whose column is not whitelisted for this query still falls back.
    expect(probe.orderBy('to', 'asc', allowed, 'date').column).toBe('date');
  });

  it('falls back to the default column for unknown keys and for injection attempts', () => {
    expect(probe.orderBy(undefined, undefined, allowed, 'date').column).toBe('date');
    expect(probe.orderBy('nonsense', undefined, allowed, 'date').column).toBe('date');
    expect(probe.orderBy("date; DROP TABLE emails--", undefined, allowed, 'date').column).toBe('date');
    expect(probe.orderBy('date DESC, (SELECT 1)', undefined, allowed, 'date').column).toBe('date');
    // The fallback itself is caller-controlled, never user-controlled.
    expect(probe.orderBy('nope', undefined, allowed, 'from_address').column).toBe('from_address');
  });

  it('normalises direction to ASC/DESC and defaults to DESC (newest mail first)', () => {
    expect(probe.orderBy('date', 'asc', allowed, 'date').direction).toBe('ASC');
    expect(probe.orderBy('date', 'ASC', allowed, 'date').direction).toBe('ASC');
    expect(probe.orderBy('date', 'desc', allowed, 'date').direction).toBe('DESC');
    expect(probe.orderBy('date', undefined, allowed, 'date').direction).toBe('DESC');
    // Anything unrecognised (including an injection payload) collapses to DESC.
    expect(probe.orderBy('date', 'asc; DROP TABLE emails', allowed, 'date').direction).toBe('DESC');
  });
});

// One canonical spelling for an address used as a primary key. The repositories
// disagreed — ContactRepository wrote `.toLowerCase().trim()`, AgentRepository
// and AiRepository read `.toLowerCase()` — so a padded address (routine from a
// header parse) was stored under one key and looked up under another, and sender
// stats / contact notes / the spammer check silently missed that contact.
describe('normalizeEmailKey', () => {
  const probe = new Probe(() => undefined as unknown as Database.Database);

  it('trims and lowercases, so every spelling maps to one key', () => {
    expect(probe.emailKey('  Padded@Spam.COM  ')).toBe('padded@spam.com');
    expect(probe.emailKey('a@b.c')).toBe('a@b.c');
    expect(probe.emailKey('\t A@B.c \n')).toBe('a@b.c');
  });

  it('is total — never throws on a missing value', () => {
    expect(probe.emailKey(undefined as unknown as string)).toBe('');
    expect(probe.emailKey(null as unknown as string)).toBe('');
    expect(probe.emailKey('')).toBe('');
  });
});

// LIKE has no default escape character in SQLite, so `%`/`_` in the user's own
// text acted as wildcards: `a_c` also matched "abc" and a lone `%` matched the
// whole mailbox. Pair this with `ESCAPE '\\'` in the SQL.
describe('likeContains', () => {
  const probe = new Probe(() => undefined as unknown as Database.Database);

  it('wraps the value for a contains match', () => {
    expect(probe.like('report')).toBe('%report%');
  });

  it('escapes the caller\'s own wildcards', () => {
    expect(probe.like('50%')).toBe('%50\\%%');
    expect(probe.like('a_c')).toBe('%a\\_c%');
    expect(probe.like('%')).toBe('%\\%%');
    // A literal backslash is escaped too, or it would consume the next char.
    expect(probe.like('C:\\x')).toBe('%C:\\\\x%');
  });

  it('leaves text with no metacharacters untouched, and handles empty input', () => {
    expect(probe.like('')).toBe('%%');
    expect(probe.like('plain text 42')).toBe('%plain text 42%');
  });
});

describe('snakeToCamelObject', () => {
  // Rows cross the IPC boundary as camelCase records; a missed key means an
  // `undefined` field in the UI (blank sender, missing date).
  it('camelises every snake_case key and preserves values (including null)', () => {
    const probe = new Probe(() => undefined as unknown as Database.Database);
    const out = probe.toCamelObject<Record<string, unknown>>({
      id: 'e1',
      from_address: 'a@b.com',
      default_content: 'x',
      has_attachments: 0,
      ai_reasoning: null,
      already: 'kept',
    });
    expect(out).toEqual({
      id: 'e1',
      fromAddress: 'a@b.com',
      defaultContent: 'x',
      hasAttachments: 0,
      aiReasoning: null,
      already: 'kept',
    });
  });

  it('only camelises underscore + LOWERCASE pairs (digits/uppercase stay put)', () => {
    const probe = new Probe(() => undefined as unknown as Database.Database);
    expect(probe.toCamelObject<Record<string, unknown>>({ col_1: 1, FROM_Address: 2, _leading: 3 })).toEqual({
      col_1: 1,
      FROM_Address: 2,
      Leading: 3,
    });
  });
});

describe('buildUpdateClauses', () => {
  const probe = new Probe(() => undefined as unknown as Database.Database);

  // The dynamic-UPDATE builder. Including an omitted (undefined) field would
  // overwrite stored data with NULL — silent data loss on every partial update.
  it('skips undefined fields but DOES write explicit null', () => {
    const { setClauses, params } = probe.updateClauses({
      name: 'Rule',
      priority: undefined,
      description: null,
    });
    expect(setClauses).toEqual(['name = @name', 'description = @description']);
    expect(params).toEqual({ name: 'Rule', description: null });
    expect('priority' in params).toBe(false);
  });

  it('stringifies jsonFields and coerces boolFields to 0/1 (SQLite has no boolean)', () => {
    const { setClauses, params } = probe.updateClauses(
      { matchType: 'any', conditions: [{ field: 'from' }], enabled: false, stopProcessing: true },
      { jsonFields: ['conditions'], boolFields: ['enabled', 'stopProcessing'] },
    );
    expect(setClauses).toEqual([
      'match_type = @matchType',
      'conditions = @conditions',
      'enabled = @enabled',
      'stop_processing = @stopProcessing',
    ]);
    expect(params.conditions).toBe('[{"field":"from"}]');
    expect(params.enabled).toBe(0);      // false must persist as 0, not be dropped
    expect(params.stopProcessing).toBe(1);
    expect(params.matchType).toBe('any');
  });

  it('treats a field listed as BOTH json and bool as json (jsonFields wins)', () => {
    const { params } = probe.updateClauses({ flags: [1, 2] }, { jsonFields: ['flags'], boolFields: ['flags'] });
    expect(params.flags).toBe('[1,2]');
  });

  it('returns nothing to update for an all-undefined patch (caller must not run an empty SET)', () => {
    const { setClauses, params } = probe.updateClauses({ a: undefined, b: undefined });
    expect(setClauses).toEqual([]);
    expect(params).toEqual({});
  });
});

describe('parseJsonField', () => {
  // Filter conditions/actions live as JSON text. One malformed blob (a partial
  // write, a hand-edited DB) must degrade to the default instead of throwing and
  // taking down the whole filters list.
  it('parses valid JSON and falls back to the default for null/empty/malformed input', () => {
    const probe = new Probe(() => undefined as unknown as Database.Database);
    expect(probe.json('[{"a":1}]', [])).toEqual([{ a: 1 }]);
    expect(probe.json(null, ['fallback'])).toEqual(['fallback']);
    expect(probe.json(undefined, ['fallback'])).toEqual(['fallback']);
    expect(probe.json('', ['fallback'])).toEqual(['fallback']);
    expect(probe.json('{not json', ['fallback'])).toEqual(['fallback']);
    // Valid JSON that happens to be falsy still round-trips as parsed.
    expect(probe.json<number | string>('0', 'fallback')).toBe(0);
  });
});

describe('now()', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Every created_at/updated_at stamp comes from here. Seconds, not millis —
  // storing millis would make dates read as year 56000 in the UI.
  it('returns whole Unix SECONDS, floored', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T10:00:00.750Z'));
    const probe = new Probe(() => undefined as unknown as Database.Database);
    expect(probe.nowSeconds()).toBe(Math.floor(Date.parse('2026-08-18T10:00:00.750Z') / 1000));
    expect(Number.isInteger(probe.nowSeconds())).toBe(true);
  });
});

describe('timed()', () => {
  let db: Database.Database;
  let events: SlowQueryEvent[];

  beforeEach(() => {
    db = newMigratedDb();
    events = [];
    setSlowQueryReporter((event) => { events.push(event); });
  });

  afterEach(() => {
    setSlowQueryReporter(null);
    vi.useRealTimers();
    db.close();
  });

  // timed() is the field instrumentation for big-mailbox stalls. It must stay
  // SILENT on the fast path (it wraps hot list queries — a log per query would
  // itself be the stall) and must emit exactly once when a query is genuinely
  // slow, otherwise we never learn about real users' 30s section queries.
  it('returns the value and reports NOTHING for a fast query', () => {
    const probe = new Probe(() => db);
    const result = probe.measure('fastQuery', () => [1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
    expect(events).toEqual([]);
  });

  it('reports a slow query with duration, row count, mailbox size and caller meta', () => {
    const probe = new Probe(() => db);
    // emails has FKs onto folders/threads (enforced here), so seed both.
    db.exec(`
      INSERT INTO folders (id, name, path) VALUES ('f1','INBOX','INBOX');
      INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
        VALUES ('t1','Hi','<m1>','<m1>',100);
      INSERT INTO emails (id, message_id, thread_id, folder_id, tags, subject, from_address, date,
                          clean_body, raw_body, content_type, content_hash)
        VALUES ('e1','<m1>','t1','f1','|INBOX|','Hi','a@b.com',100,'body','raw','text','h1');
    `);

    // Fake timers make the "slow" path exact and instant — the wrapped work
    // advances the clock by 45ms of virtual time instead of really stalling.
    vi.useFakeTimers();
    const result = probe.measure('slowQuery', () => {
      vi.advanceTimersByTime(45);
      return ['a', 'b'];
    }, { folderPath: 'INBOX' });

    expect(result).toEqual(['a', 'b']);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      label: 'slowQuery',
      ms: 45,
      rows: 2,
      totalEmails: 1,
      meta: { folderPath: 'INBOX' },
    });
  });

  it('leaves rows undefined for a non-array result and tolerates meta being omitted', () => {
    const probe = new Probe(() => db);
    vi.useFakeTimers();
    const result = probe.measure('slowScalar', () => {
      vi.advanceTimersByTime(40);   // exactly at the threshold — still reported
      return 7;
    });
    expect(result).toBe(7);
    expect(events).toHaveLength(1);
    expect(events[0].rows).toBeUndefined();
    expect(events[0].meta).toBeUndefined();
    expect(events[0].ms).toBe(40);
  });

  it('still reports when the mailbox-size probe fails (no emails table)', () => {
    // The totalEmails lookup is diagnostic only; a DB without the emails table
    // (an ancillary/registry DB) must not turn a slow-query log into a throw.
    const bare = openTestDb();
    bare.exec('CREATE TABLE misc (id TEXT PRIMARY KEY)');
    const probe = new Probe(() => bare);

    vi.useFakeTimers();
    expect(probe.measure('slowOnBareDb', () => {
      vi.advanceTimersByTime(60);
      return [];
    })).toEqual([]);

    expect(events).toHaveLength(1);
    expect(events[0].totalEmails).toBeUndefined();
    expect(events[0].rows).toBe(0);
    bare.close();
  });

  it('propagates the wrapped error without reporting (a throw is not a slow query)', () => {
    const probe = new Probe(() => db);
    expect(() => probe.measure('boom', () => { throw new Error('sql error'); })).toThrow('sql error');
    expect(events).toEqual([]);
  });
});
