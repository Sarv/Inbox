import type { ConfirmChoice } from '../ConfirmDialog';

/**
 * Above this many pending bodies, downloading them all is a long IMAP run, so
 * the button asks rather than just starting it.
 *
 * The number is deliberately the pipeline's AUTO_BACKLOG_RECENT_CAP: mail
 * outside the newest 500 by date is NOT auto-categorised when its body lands
 * (see `triggerCategorizeFor`), so "download the first 500" is also the batch
 * most likely to be picked up without a separate manual run.
 */
export const DOWNLOAD_BATCH = 500;

export interface DownloadPlan {
  /** Nothing pending — the button should not be offered at all. */
  empty: boolean;
  /** Enough pending that committing to all of it deserves a question. */
  needsPrompt: boolean;
  /** Size of the "first batch" option. Never more than what's pending. */
  batch: number;
  /** Size of the "everything" option. */
  all: number;
}

/**
 * What the "Download bodies" button should do for a backlog of `pending`.
 *
 * Pure so the threshold behaviour can be tested without a renderer: the
 * off-by-one at the boundary is exactly the kind of thing that silently turns
 * a prompt into a 4,000-email download nobody asked for.
 */
export function planBodyDownload(pending: number, batch: number = DOWNLOAD_BATCH): DownloadPlan {
  const all = Math.max(0, Math.floor(pending));
  const size = Math.max(1, Math.floor(batch));
  return {
    empty: all <= 0,
    // Strictly greater: a backlog that fits in one batch has nothing to choose
    // between — both buttons would download the same mail.
    needsPrompt: all > size,
    batch: Math.min(size, all),
    all,
  };
}

/**
 * How many bodies the user's answer asks for, or null if they declined.
 *
 * `confirm` is the first batch (the recommended, primary button) and
 * `secondary` is the whole backlog — so a dismissed dialog (Escape, backdrop),
 * which reports `cancel`, can never start the long run by accident.
 */
export function targetForChoice(choice: ConfirmChoice, plan: DownloadPlan): number | null {
  if (choice === 'confirm') return plan.batch;
  if (choice === 'secondary') return plan.all;
  return null;
}
