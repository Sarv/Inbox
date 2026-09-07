import { describe, expect, it } from 'vitest';

import {
  summariseCompaction,
  type CompactionResultLike,
} from '../../../../../src/components/settings/compaction-summary';

/**
 * The sentence shown after a rebuild finishes.
 *
 * What breaks if this file fails: the user's understanding of what the button
 * did to their mail. "Compress" reads as a lossy or archiving operation to most
 * people, so a bare byte figure leaves the real question unanswered — and the
 * one claim that must never drift is that nothing was deleted.
 */

/** `formatBytes` is binary (GiB), so the fixture has to be too. */
const GB = 1024 ** 3;

// The real numbers from the first live run on the 9.8 GB Gmail account.
const base: CompactionResultLike = {
  reclaimedBytes: 8.1 * GB,
  beforeBytes: 9.8 * GB,
  afterBytes: 1.7 * GB,
  elapsedMs: 31_000,
  emailCount: 26_262,
  rowsPreserved: true,
  autoVacuumEnabled: true,
};

describe('summariseCompaction', () => {
  // Breaks: the user is told how many bytes moved but not whether their mail
  // survived — which is the only thing they actually wanted to know.
  it('states the surviving email count alongside the space freed', () => {
    const { text, tone } = summariseCompaction(base);

    expect(tone).toBe('success');
    expect(text).toContain('26,262 emails are still here');
    expect(text).toContain('nothing was deleted');
    expect(text).toMatch(/Freed .*8\.1 GB/);
  });

  // Breaks: an account with no readable count renders "All null emails".
  it('drops the count but keeps the reassurance when the count is unknown', () => {
    const { text } = summariseCompaction({ ...base, emailCount: null });

    expect(text).not.toContain('null');
    expect(text).toContain('No mail was deleted or changed.');
  });

  /**
   * Breaks: SQLite's INCREMENTAL auto-vacuum does not hand space back on its
   * own — it only makes a later reclaim cheap. Promising self-cleaning would be
   * a claim the user can disprove by watching the file not shrink.
   */
  it('does not claim the database now cleans itself', () => {
    const { text } = summariseCompaction(base);

    expect(text).toContain('reclaim space without a full rebuild');
    expect(text).not.toMatch(/on its own|automatically|by itself/i);
  });

  // Breaks: a database that could not be converted silently looks identical to
  // one that was, and nobody learns the bloat is coming back.
  it('omits the auto-vacuum line when the conversion did not take', () => {
    const { text } = summariseCompaction({ ...base, autoVacuumEnabled: false });

    expect(text).not.toContain('full rebuild');
    expect(text).toContain('26,262 emails are still here');
  });

  // Breaks: a rebuild that reclaimed nothing ends with a spinner that stopped
  // and no explanation of what happened.
  it('reports a zero-gain rebuild as a success, not a blank', () => {
    const { text, tone } = summariseCompaction({ ...base, reclaimedBytes: 0 });

    expect(tone).toBe('success');
    expect(text).toContain('no wasted space left to reclaim');
  });

  /**
   * Breaks: THE one that matters. VACUUM is lossless, so this should be
   * impossible — but if it ever happens the user must hear it from the app
   * immediately, in a warning, not discover missing mail days later.
   */
  it('warns loudly and says nothing about bytes when rows were lost', () => {
    const { text, tone } = summariseCompaction({ ...base, rowsPreserved: false, emailCount: 26_000 });

    expect(tone).toBe('warning');
    expect(text).toContain('number of emails in it changed');
    expect(text).not.toContain('Freed');
  });

  // Breaks: a sub-second rebuild reports "took 0s", which reads as not having
  // run at all.
  it('never reports zero seconds', () => {
    const { text } = summariseCompaction({ ...base, elapsedMs: 120 });

    expect(text).toContain('took 1s');
  });
});
