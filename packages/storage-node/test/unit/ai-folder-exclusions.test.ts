import { describe, it, expect } from 'vitest';

import {
  AGENT_EXCLUDED_TAGS,
  EXCLUDED_FOLDER_TAGS,
  notExcludedByTagsClause,
  notInExcludedFolderClause,
} from '../../src/repositories/agent-eligibility';
import { newMigratedDb } from '../../src/test-support/test-db';

/**
 * Which folders the AI is allowed to spend a call on.
 *
 * THE incident this pins: this list existed TWICE — here, and again as
 * `excludeSpecialFolders` in ai-repository, which the category chips and
 * category views are built from. They disagreed. The pipeline's copy was
 * missing Drafts, Sent, Junk Email, Deleted Items and Sent Items, so the AI
 * categorised the user's own drafts and sent mail and the chips then filtered
 * every result straight back out: 140 messages in one real mailbox, paid for in
 * LLM calls, invisible in the UI, and counted in "Already AI-processed".
 *
 * A divergence here is silent in exactly the way this repo's worst bugs are
 * silent — nothing crashes, nothing logs, the work is just wasted.
 */
describe('the AI folder-exclusion list', () => {
  // THE regression. Categorising your own outbox tells you nothing, and a
  // priority score on a message you wrote yourself is meaningless.
  it('excludes the user\'s own drafts and sent mail', () => {
    for (const tag of ['|Drafts|', '|Sent|', '|[Gmail]/Drafts|', '|[Gmail]/Sent Mail|', '|Sent Items|']) {
      expect(EXCLUDED_FOLDER_TAGS).toContain(tag);
    }
  });

  it('excludes deleted and junk mail in every provider spelling', () => {
    for (const tag of [
      '|Trash|', '|Deleted Items|', '|[Gmail]/Trash|',
      '|Spam|', '|Junk|', '|Junk Email|', '|[Gmail]/Spam|',
    ]) {
      expect(EXCLUDED_FOLDER_TAGS).toContain(tag);
    }
  });

  // The pipeline's list is the folder list PLUS read mail. Stated as a test so
  // a tag added to one can never quietly fail to reach the other.
  it('is exactly the pipeline list, minus the read-state test', () => {
    expect([...AGENT_EXCLUDED_TAGS]).toEqual(['|read|', ...EXCLUDED_FOLDER_TAGS]);
  });

  // A category VIEW pages over read and unread alike and adds its own unread
  // filter when it wants one. Folding `|read|` in here would empty every
  // category view of everything the user had already opened.
  it('does not judge read state — only folders', () => {
    expect(notInExcludedFolderClause()).not.toContain('|read|');
    expect(notExcludedByTagsClause()).toContain('|read|');
  });

  it('qualifies the column with a table alias when given one', () => {
    expect(notInExcludedFolderClause('e')).toContain("instr(e.tags, '|Drafts|')");
  });
});

/**
 * The clauses have to be valid SQL that actually selects what they claim, not
 * just a correctly-shaped string — these are pasted into WHERE clauses by hand.
 */
describe('the exclusion clauses against a real database', () => {
  let n = 0;
  const seed = (db: ReturnType<typeof newMigratedDb>, tags: string) => {
    n += 1;
    db.prepare(
      `INSERT INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
       VALUES (?, 's', ?, ?, 1)`,
    ).run(`t${n}`, `<m${n}@x>`, `<m${n}@x>`);
    db.prepare(
      `INSERT INTO emails (id, message_id, thread_id, folder_id, uid, tags, subject,
         from_address, date, raw_body, clean_body, raw_body_len, clean_body_len,
         content_type, content_hash)
       VALUES (?, ?, ?, 'f1', ?, ?, 's', 'a@b.com', 1, 'b', 'b', 1, 1, 'text', ?)`,
    ).run(`e${n}`, `<m${n}@x>`, `t${n}`, n, tags, `h${n}`);
  };
  const fresh = () => {
    n = 0;
    const db = newMigratedDb();
    db.prepare(`INSERT INTO folders (id, path, name) VALUES ('f1','INBOX','INBOX')`).run();
    return db;
  };
  const count = (db: ReturnType<typeof newMigratedDb>, where: string): number =>
    (db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE ${where}`).get() as { n: number }).n;

  // THE behaviour the whole change is for: a draft must not reach the AI.
  it('keeps drafts and sent mail out of the AI pipeline', () => {
    const db = fresh();
    seed(db, '|INBOX|');
    seed(db, '|Drafts|');
    seed(db, '|Sent|');

    expect(count(db, notExcludedByTagsClause())).toBe(1);
  });

  it('keeps read mail out of the pipeline but inside a category view', () => {
    const db = fresh();
    seed(db, '|INBOX|');
    seed(db, '|INBOX|read|');

    expect(count(db, notExcludedByTagsClause())).toBe(1);
    // The view wants both — it filters unread separately when it needs to.
    expect(count(db, notInExcludedFolderClause())).toBe(2);
  });

  // Archive is a normal folder. Excluding it would silently drop most of a
  // tidy mailbox from categorisation.
  it('leaves ordinary folders such as Archive alone', () => {
    const db = fresh();
    seed(db, '|Archive|');
    seed(db, '|Archive|bulk|');

    expect(count(db, notExcludedByTagsClause())).toBe(2);
  });

  // `instr` is a substring test, so a folder whose name CONTAINS an excluded
  // name must not be caught by it. The pipe delimiters are what prevent this,
  // and they are easy to drop when editing the list.
  it('does not exclude a folder whose name merely contains an excluded one', () => {
    const db = fresh();
    seed(db, '|Sent Reports|');
    seed(db, '|Trashed Ideas|');

    expect(count(db, notExcludedByTagsClause())).toBe(2);
  });
});
