import { describe, expect, it } from 'vitest';

import {
  planBodyDownload,
  targetForChoice,
  DOWNLOAD_BATCH,
} from '../../../../../src/components/aibox/body-download-plan';

/**
 * The "Download bodies" button on the AI dashboard.
 *
 * What this protects: the button commits the app to a long IMAP run against the
 * user's mail server. The threshold decides whether that run starts silently or
 * only after the user picks a size, so an off-by-one here is the difference
 * between a prompt and four thousand unasked-for FETCHes.
 */
describe('planBodyDownload', () => {
  // THE guard: a big backlog must never start downloading without being asked.
  it('asks before committing to a backlog larger than one batch', () => {
    expect(planBodyDownload(757).needsPrompt).toBe(true);
  });

  // A backlog that fits in one batch has nothing to choose between — both
  // buttons would download exactly the same mail, so the prompt is just a
  // click in the way.
  it('does not ask when the whole backlog fits in one batch', () => {
    expect(planBodyDownload(200).needsPrompt).toBe(false);
  });

  // The boundary in both directions. `> batch`, not `>=`: at exactly the batch
  // size the two options are identical.
  it('treats exactly one batch as no prompt, and one more as a prompt', () => {
    expect(planBodyDownload(DOWNLOAD_BATCH).needsPrompt).toBe(false);
    expect(planBodyDownload(DOWNLOAD_BATCH + 1).needsPrompt).toBe(true);
  });

  // Offering "download 500" out of 12 would promise mail that does not exist
  // and leave the button's own label wrong.
  it('never offers a batch larger than the backlog', () => {
    const plan = planBodyDownload(12);
    expect(plan.batch).toBe(12);
    expect(plan.all).toBe(12);
  });

  // Nothing pending: the caller uses this to not render the button at all.
  it('reports an empty backlog rather than a zero-sized run', () => {
    expect(planBodyDownload(0).empty).toBe(true);
    expect(planBodyDownload(1).empty).toBe(false);
  });

  // A count arriving from IPC is not guaranteed sane. A negative must read as
  // empty, not wrap into a huge run.
  it('treats a negative or fractional count as a whole, non-negative backlog', () => {
    expect(planBodyDownload(-5)).toMatchObject({ empty: true, all: 0, batch: 0 });
    expect(planBodyDownload(10.7).all).toBe(10);
  });

  it('honours a caller-supplied batch size', () => {
    const plan = planBodyDownload(300, 100);
    expect(plan.needsPrompt).toBe(true);
    expect(plan.batch).toBe(100);
  });

  // A zero batch would make every backlog "needs prompt" and then download
  // nothing when the user picked the batch.
  it('refuses a zero or negative batch size instead of planning an empty run', () => {
    expect(planBodyDownload(50, 0).batch).toBe(1);
    expect(planBodyDownload(50, -10).batch).toBe(1);
  });
});

describe('targetForChoice', () => {
  const plan = planBodyDownload(757);

  it('downloads one batch for the primary button', () => {
    expect(targetForChoice('confirm', plan)).toBe(DOWNLOAD_BATCH);
  });

  it('downloads the whole backlog for the secondary button', () => {
    expect(targetForChoice('secondary', plan)).toBe(757);
  });

  // THE reason "all" is the SECONDARY button rather than the primary one:
  // Escape and a backdrop click both report `cancel`, and Enter activates the
  // primary. Neither gesture can start the long run by accident.
  it('starts nothing when the dialog is dismissed', () => {
    expect(targetForChoice('cancel', plan)).toBeNull();
  });
});
