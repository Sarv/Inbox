import type Database from 'better-sqlite3';

/**
 * Queue every thread that has an email tagged `|tag|` for a read-model rebuild.
 *
 * A change to the category DEFINITIONS (one added, deleted, or seeded by a
 * migration) changes what a thread's `has_category` rollup derives to without
 * writing any `emails` row, so the emails triggers that normally fill
 * `read_model_dirty` never fire. This is how such a change reaches the read
 * model. Returns how many threads were newly queued.
 */
export function enqueueThreadsTaggedWith(db: Database.Database, tag: string): number {
  if (!tag) return 0;
  return db
    .prepare(
      "INSERT OR IGNORE INTO read_model_dirty(thread_id) SELECT DISTINCT thread_id FROM emails WHERE instr(tags, '|' || ? || '|') > 0",
    )
    .run(tag).changes;
}
