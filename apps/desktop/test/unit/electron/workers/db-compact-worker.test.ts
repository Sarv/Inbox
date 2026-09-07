import { describe, expect, it, vi } from 'vitest';

// The packaged binding is compiled for ELECTRON's ABI and cannot be dlopen'd by
// vitest's Node, and the worker imports it at module scope. Nothing here needs a
// real database — `rebuildInPlace` is written against an interface precisely so
// the sequence can be checked without one — so stub the import away.
vi.mock('better-sqlite3', () => ({ default: class {} }));

import { rebuildInPlace, type CompactableDb } from '../../../../electron/workers/db-compact.worker';

/**
 * The VACUUM step sequence.
 *
 * What breaks if this file fails, OBSERVED on the 9.8 GB Gmail account: the
 * rebuild reported `9.8 GB -> 1.7 GB` and left a 1.7 GB `-wal` sidecar sitting
 * next to the 1.7 GB file. In WAL mode VACUUM writes the ENTIRE rebuilt
 * database through the WAL, so at the instant it finishes the sidecar is as
 * large as the new main file. The worker checkpointed BEFORE the VACUUM only,
 * so the user was told they got 8.1 GB back when the directory had only given
 * up 6.4 GB.
 *
 * None of this throws. The pragmas all succeed, the stats all read correctly,
 * and the only witness is the order they run in — which is what this asserts.
 */

interface FakeDbOptions {
  before: number;
  after: number;
  rows?: number | null;
  /** What the file reports for `auto_vacuum` once the VACUUM has converted it. */
  autoVacuumAfter?: number;
  /** Simulates a database with no `emails` table. */
  countThrows?: boolean;
}

/**
 * Records every statement in order and answers the pragmas.
 *
 * Deliberately models the ONE behaviour that makes `auto_vacuum` subtle: the
 * mode only changes when a VACUUM runs. Setting the pragma alone leaves the
 * file reporting its old mode, exactly as SQLite does — so a test that moves
 * the pragma after the VACUUM sees the conversion fail here too.
 */
function recordingDb(options: FakeDbOptions): CompactableDb & { statements: string[] } {
  const { before, after, rows = 1_000, autoVacuumAfter = 2, countThrows = false } = options;
  const statements: string[] = [];
  let vacuumed = false;
  let requestedAutoVacuum = 0;
  let autoVacuum = 0;

  return {
    statements,
    pragma(source: string, pragmaOptions?: { simple?: boolean }) {
      statements.push(source);
      if (source === 'auto_vacuum = INCREMENTAL') requestedAutoVacuum = autoVacuumAfter;
      if (!pragmaOptions?.simple) return undefined;
      if (source === 'page_size') return 4096;
      if (source === 'page_count') return vacuumed ? after : before;
      if (source === 'freelist_count') return vacuumed ? 0 : before - after;
      if (source === 'auto_vacuum') return autoVacuum;
      return undefined;
    },
    exec(source: string) {
      statements.push(source);
      if (source === 'VACUUM') {
        vacuumed = true;
        // The conversion happens HERE and only here.
        autoVacuum = requestedAutoVacuum;
      }
      return undefined;
    },
    prepare(source: string) {
      statements.push(source);
      return {
        get() {
          if (countThrows) throw new Error('no such table: emails');
          return { n: rows };
        },
      };
    },
  };
}

describe('rebuildInPlace', () => {
  // Breaks: THE regression above — a gigabyte-scale WAL survives the rebuild and
  // half the reclaimed space never reaches the disk.
  it('checkpoints the WAL AFTER the VACUUM, not only before it', () => {
    const db = recordingDb({ before: 2_400_000, after: 420_000 });

    rebuildInPlace(db);

    const checkpoints = db.statements
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) => statement === 'wal_checkpoint(TRUNCATE)')
      .map(({ index }) => index);
    const vacuum = db.statements.indexOf('VACUUM');

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toBeLessThan(vacuum);
    expect(checkpoints[1]).toBeGreaterThan(vacuum);
  });

  // Breaks: SQLite is asked to hold a multi-gigabyte rebuild in RAM (the app's
  // own connections run `temp_store = MEMORY`), and the VACUUM dies on a large
  // mailbox — exactly the mailbox that needed it.
  it('pins temp storage to disk before doing anything else', () => {
    const db = recordingDb({ before: 100, after: 50 });

    rebuildInPlace(db);

    expect(db.statements[0]).toBe('temp_store = FILE');
  });

  // Breaks: the after-figure is read with gigabytes still in flight through the
  // WAL, so the size reported to the user is not the size on disk.
  it('reads the after-stats past the trailing checkpoint', () => {
    const db = recordingDb({ before: 2_400_000, after: 420_000 });

    const { after } = rebuildInPlace(db);

    const lastCheckpoint = db.statements.lastIndexOf('wal_checkpoint(TRUNCATE)');
    expect(db.statements.indexOf('page_count', lastCheckpoint)).toBeGreaterThan(lastCheckpoint);
    expect(after.pageCount).toBe(420_000);
  });

  // Breaks: the reclaimed figure is computed against a post-VACUUM snapshot on
  // both sides and always reads as zero — the button appears to do nothing.
  it('captures the before-stats while the freelist is still there', () => {
    const db = recordingDb({ before: 2_400_000, after: 420_000 });

    const { before } = rebuildInPlace(db);

    expect(before.pageCount).toBe(2_400_000);
    expect(before.freelistCount).toBe(2_400_000 - 420_000);
    expect(before.pageSize).toBe(4096);
  });

  /**
   * Breaks: silently. Changing `auto_vacuum` on an existing database does
   * NOTHING on its own — SQLite only converts the page layout during a VACUUM.
   * Set after the rebuild (or anywhere else in the app) the pragma is accepted,
   * reports success, and is ignored until the next full rebuild. This VACUUM is
   * the only chance to convert the file, and the mode is read back off the file
   * rather than assumed for exactly that reason.
   */
  it('requests incremental auto-vacuum BEFORE the VACUUM, and confirms it took', () => {
    const db = recordingDb({ before: 2_400_000, after: 420_000 });

    const { autoVacuum } = rebuildInPlace(db);

    expect(db.statements.indexOf('auto_vacuum = INCREMENTAL')).toBeLessThan(
      db.statements.indexOf('VACUUM'),
    );
    expect(autoVacuum).toBe(2);
  });

  // Breaks: a file that refused the conversion is reported as converted, and
  // nobody learns the bloat is coming back.
  it('reports the mode the file actually ended up in, not the one requested', () => {
    const db = recordingDb({ before: 2_400_000, after: 420_000, autoVacuumAfter: 0 });

    expect(rebuildInPlace(db).autoVacuum).toBe(0);
  });

  // Breaks: the app can no longer prove to the user that no mail was lost —
  // the whole basis of the "nothing was deleted" line in the UI.
  it('counts the emails on both sides of the rebuild', () => {
    const db = recordingDb({ before: 2_400_000, after: 420_000, rows: 26_262 });

    const { rowsBefore, rowsAfter } = rebuildInPlace(db);

    expect(rowsBefore).toBe(26_262);
    expect(rowsAfter).toBe(26_262);
  });

  // Breaks: a database without the table throws out of a rebuild that had
  // otherwise already succeeded and swapped the file in.
  it('survives a database it cannot count, reporting nulls', () => {
    const db = recordingDb({ before: 2_400_000, after: 420_000, countThrows: true });

    const { rowsBefore, rowsAfter, after } = rebuildInPlace(db);

    expect(rowsBefore).toBeNull();
    expect(rowsAfter).toBeNull();
    expect(after.pageCount).toBe(420_000);
  });
});
