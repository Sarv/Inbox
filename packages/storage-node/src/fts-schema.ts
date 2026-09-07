/**
 * The CURRENT definition of the FTS5 search index and the triggers that
 * maintain it — one copy, imported by everything that builds it.
 *
 * This file exists because the definition was in three places: migration 27
 * created it, migration 57 recreated the update trigger to add a gate, and
 * `SearchRepository.initializeFTS()` created it again at runtime for databases
 * that somehow lacked it. When the bodies moved to `email_bodies` (migration
 * 73), two of those copies still read `emails.clean_body` — which is NULL after
 * relocation. The runtime copy would have quietly recreated the old triggers on
 * any DB missing one, and `rebuildIndex()` would have re-indexed the entire
 * mailbox with empty bodies: mail still lists, still opens, and stops being
 * findable, with no error anywhere.
 *
 * Historical migrations 27 and 57 keep their own inline copies ON PURPOSE. A
 * migration records what it did at the time; pointing v27 at this file would make
 * a fresh chain create triggers that reference `email_bodies` hundreds of
 * versions before that table exists. SQLite compiles trigger bodies lazily, so
 * that would not fail at CREATE — it would fail on the first INSERT, which is
 * worse. Everything from v73 onwards uses this file.
 *
 * The body always reads through `email_bodies` with the inline column as
 * fallback, and the WHEN guards are explained in migration 73.
 */

/** The virtual table. `email_id` is UNINDEXED — it is a key, not a search term. */
export const FTS_TABLE_DDL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS emails_fts USING fts5(
    email_id UNINDEXED,
    subject,
    from_address,
    from_name,
    to_address,
    cc_address,
    attachment_names,
    clean_body,
    tokenize='unicode61 remove_diacritics 2'
  );
`;

/** The indexed columns, in the order the virtual table declares them. */
export const FTS_COLUMNS =
  'email_id, subject, from_address, from_name, to_address, cc_address, attachment_names, clean_body';

/** The effective body of one email, wherever it is currently stored. */
export const ftsBodySource = (idExpr: string, inlineExpr: string): string =>
  `COALESCE((SELECT b.clean_body FROM email_bodies b WHERE b.email_id = ${idExpr}), ${inlineExpr})`;

/** Index row built from an `emails` row in scope as `new`. */
const INSERT_FROM_NEW_EMAIL = `
  INSERT INTO emails_fts(${FTS_COLUMNS})
  VALUES (
    new.id, new.subject, new.from_address, new.from_name, new.to_address, new.cc_address, new.attachment_names,
    ${ftsBodySource('new.id', 'new.clean_body')}
  );
`;

/**
 * Index row built from a body row in scope as `new`/`old`, reading the headers
 * back from `emails`. The `WHERE` is load-bearing during a cascade delete: the
 * header row is already gone, so the SELECT matches nothing and no orphan index
 * entry is written.
 */
const insertFromBodyRow = (bodyExpr: string, idExpr: string): string => `
  INSERT INTO emails_fts(${FTS_COLUMNS})
  SELECT e.id, e.subject, e.from_address, e.from_name, e.to_address, e.cc_address, e.attachment_names, ${bodyExpr}
  FROM emails e WHERE e.id = ${idExpr};
`;

/**
 * Every trigger that maintains the index, as `[name, ddl]` pairs.
 *
 * Returned as a list so callers can DROP each by name before creating it:
 * `CREATE TRIGGER IF NOT EXISTS` is the wrong tool here, because the whole point
 * is replacing an older trigger of the same name.
 */
export const FTS_TRIGGERS: ReadonlyArray<readonly [string, string]> = [
  [
    'emails_fts_insert',
    `CREATE TRIGGER emails_fts_insert AFTER INSERT ON emails BEGIN
      ${INSERT_FROM_NEW_EMAIL}
    END;`,
  ],
  [
    'emails_fts_delete',
    `CREATE TRIGGER emails_fts_delete AFTER DELETE ON emails BEGIN
      DELETE FROM emails_fts WHERE email_id = old.id;
      -- Not left to ON DELETE CASCADE: \`PRAGMA foreign_keys\` is per-connection
      -- and defaults to OFF, so a tool or a future code path that opens this DB
      -- without setting it would leak a body row per deleted email — the largest
      -- rows in the database, invisible to every query.
      DELETE FROM email_bodies WHERE email_id = old.id;
    END;`,
  ],
  [
    // Keeps migration 57's gate — re-index only when a search-relevant column
    // changes, so a mark-read does not re-tokenize a body — and adds the
    // relocation guard: once a side row exists it IS the effective body, so
    // nulling the inline column changes nothing worth re-indexing.
    'emails_fts_update',
    `CREATE TRIGGER emails_fts_update AFTER UPDATE ON emails
      WHEN new.subject IS NOT old.subject
        OR new.from_address IS NOT old.from_address
        OR new.from_name IS NOT old.from_name
        OR new.to_address IS NOT old.to_address
        OR new.cc_address IS NOT old.cc_address
        OR new.attachment_names IS NOT old.attachment_names
        OR (new.clean_body IS NOT old.clean_body
            AND NOT EXISTS (SELECT 1 FROM email_bodies b WHERE b.email_id = new.id))
    BEGIN
      DELETE FROM emails_fts WHERE email_id = old.id;
      ${INSERT_FROM_NEW_EMAIL}
    END;`,
  ],
  [
    // Fires for a body that arrives AFTER its header row, which is the normal
    // case: sync stores the header, then fetchBody fills the body in. The guard
    // skips relocation, where the arriving body equals the inline column it
    // replaces — without it the move would re-tokenize the whole mailbox.
    'email_bodies_fts_insert',
    `CREATE TRIGGER email_bodies_fts_insert AFTER INSERT ON email_bodies
      WHEN new.clean_body IS NOT (SELECT e.clean_body FROM emails e WHERE e.id = new.email_id)
    BEGIN
      DELETE FROM emails_fts WHERE email_id = new.email_id;
      ${insertFromBodyRow('new.clean_body', 'new.email_id')}
    END;`,
  ],
  [
    'email_bodies_fts_update',
    `CREATE TRIGGER email_bodies_fts_update AFTER UPDATE ON email_bodies
      WHEN new.clean_body IS NOT old.clean_body
    BEGIN
      DELETE FROM emails_fts WHERE email_id = new.email_id;
      ${insertFromBodyRow('new.clean_body', 'new.email_id')}
    END;`,
  ],
  [
    // A body row deleted while its email survives: the effective body falls back
    // to the inline column (normally NULL), so the entry keeps its header terms
    // and loses its body terms. Without this it would keep terms for a body that
    // no longer exists.
    'email_bodies_fts_delete',
    `CREATE TRIGGER email_bodies_fts_delete AFTER DELETE ON email_bodies BEGIN
      DELETE FROM emails_fts WHERE email_id = old.email_id;
      ${insertFromBodyRow('e.clean_body', 'old.email_id')}
    END;`,
  ],
];

/**
 * Full re-index of every email from scratch.
 *
 * Reads the body through `email_bodies` — a rebuild that read the inline column
 * would silently produce a body-less index on any relocated database.
 */
export const FTS_REBUILD_SQL = `
  INSERT INTO emails_fts(${FTS_COLUMNS})
  SELECT id, subject, from_address, from_name, to_address, cc_address, attachment_names,
         ${ftsBodySource('emails.id', 'clean_body')}
  FROM emails;
`;

/**
 * Index only the emails that have no entry yet — used to fill in rows written
 * while the index did not exist. `NOT EXISTS` rather than a blind insert: the
 * table is created with IF NOT EXISTS and may already be populated, and
 * indexing a message twice makes search return every hit twice.
 */
export const FTS_BACKFILL_MISSING_SQL = `
  INSERT INTO emails_fts(${FTS_COLUMNS})
  SELECT id, subject, from_address, from_name, to_address, cc_address, attachment_names,
         ${ftsBodySource('emails.id', 'clean_body')}
  FROM emails
  WHERE NOT EXISTS (SELECT 1 FROM emails_fts WHERE emails_fts.email_id = emails.id);
`;

/** Create the table and (re)create every trigger, replacing any older copy. */
export function applyFtsSchema(db: {
  exec: (sql: string) => unknown;
}): void {
  db.exec(FTS_TABLE_DDL);
  for (const [name, ddl] of FTS_TRIGGERS) {
    db.exec(`DROP TRIGGER IF EXISTS ${name};`);
    db.exec(ddl);
  }
}
