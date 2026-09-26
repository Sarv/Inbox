import { describe, expect, it } from 'vitest';

import {
  EMAIL_TAGS_TABLE,
  EMAIL_TAGS_TAG_INDEX,
  hasTagClause,
  tagSplitRowsSql,
} from '../../../src/repositories/tag-membership';
import { openTestDb } from '../../../src/test-support/test-db';

// These builders are the ONLY place the app decides how a `|a|b|` tag string
// becomes rows, and three very different consumers share them: the v91 backfill,
// the triggers that keep `email_tags` in step with every write, and the query
// sites that read it. If they could disagree, a message would be a member of a
// folder for one of them and not the others — mail visible in the list with a
// badge that says zero, or the reverse. Everything here is a pure string, so the
// split is tested by RUNNING it against SQLite rather than matching text.

/** Run the split over a literal tag string, the way the backfill does. */
function split(db: ReturnType<typeof openTestDb>, tags: string | null): string[] {
  db.prepare('DELETE FROM emails').run();
  db.prepare('INSERT INTO emails (id, tags) VALUES (?,?)').run('e1', tags);
  return (db.prepare(tagSplitRowsSql('id', 'tags', 'FROM emails')).all() as { tag: string }[])
    .map((row) => row.tag);
}

describe('tagSplitRowsSql — the one definition of "split a tag string"', () => {
  const db = openTestDb();
  db.exec("CREATE TABLE emails (id TEXT PRIMARY KEY, tags TEXT)");

  it('yields one row per token', () => {
    expect(split(db, '|INBOX|read|Work|')).toEqual(['INBOX', 'read', 'Work']);
  });

  // Regression: `buildTags` writes '||' for a message with no tags. Split naively
  // and that sentinel becomes an empty-string tag on EVERY such row — a token
  // that then matches any probe binding '', and a membership table with tens of
  // thousands of junk rows.
  it('yields nothing for the empty-tags sentinel', () => {
    expect(split(db, '||')).toEqual([]);
  });

  // Regression: a NULL tags column exists on older rows; the CTE must not
  // produce a row with a NULL id, which would violate the table's primary key
  // and abort the whole backfill.
  it('yields nothing for NULL tags', () => {
    expect(split(db, null)).toEqual([]);
  });

  // Regression: a doubled delimiter contributes an EMPTY token. Left in, it is
  // the same junk row as the sentinel.
  it('drops the empty token a doubled delimiter would contribute', () => {
    expect(split(db, '|INBOX||Work|')).toEqual(['INBOX', 'Work']);
  });

  // Regression: THE cross-counting bug. Tokens are whole, so a folder whose path
  // prefixes another can never absorb its children.
  it('keeps a nested folder path whole', () => {
    expect(split(db, '|Work|Work/Reports|')).toEqual(['Work', 'Work/Reports']);
  });

  it('handles a single tag, and tags with spaces', () => {
    expect(split(db, '|INBOX|')).toEqual(['INBOX']);
    expect(split(db, '|Sarv Inbox/Invoices|')).toEqual(['Sarv Inbox/Invoices']);
  });

  // Regression: a malformed string (no trailing delimiter) must terminate. The
  // recursion is driven by instr(rest,'|'), so the last fragment simply ends the
  // chain instead of looping forever.
  it('terminates on a string missing its trailing delimiter', () => {
    expect(split(db, '|INBOX|Work')).toEqual(['INBOX']);
  });

  // Regression: inside a trigger there is no FROM clause — NEW.id and NEW.tags
  // are scalars. The builder must emit valid SQL with the source omitted.
  it('builds a FROM-less form for use inside a trigger', () => {
    const sql = tagSplitRowsSql("'e9'", "'|A|B|'");
    expect(sql).not.toContain('FROM emails');
    expect((db.prepare(sql).all() as { id: string; tag: string }[])).toEqual([
      { id: 'e9', tag: 'A' },
      { id: 'e9', tag: 'B' },
    ]);
  });
});

describe('hasTagClause — the drop-in membership predicate', () => {
  // Regression: it replaces `instr(tags, '|' || ? || '|') > 0` in existing WHERE
  // clauses. Exactly ONE bound parameter, in the same position, or every rewrite
  // silently shifts the bindings around it.
  it('takes exactly one bound parameter', () => {
    expect(hasTagClause().match(/\?/g)).toHaveLength(1);
  });

  it('qualifies the id column when given a table alias', () => {
    expect(hasTagClause()).toContain('id IN (');
    expect(hasTagClause('e')).toContain('e.id IN (');
  });

  it('reads the membership table by tag', () => {
    expect(hasTagClause()).toContain(`FROM ${EMAIL_TAGS_TABLE} WHERE tag = ?`);
  });
});

describe('the index name', () => {
  // Regression: the migration creates it and the doc comments claim the seek.
  // One place defines the name so a rename cannot leave a query behind.
  it('is the covering index the rewrites rely on', () => {
    expect(EMAIL_TAGS_TAG_INDEX).toBe('idx_email_tags_tag');
  });
});
