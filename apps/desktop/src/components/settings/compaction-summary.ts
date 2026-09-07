import { formatBytes } from '../quota-format';

/**
 * Turns a finished rebuild into the sentence the user reads afterwards.
 *
 * Pure and separate from the component on purpose: the wording IS the feature
 * here. "Compress" is a word people associate with lossy formats and with
 * archives that have to be unpacked before they work again, so a bare
 * "Freed 8.1 GB" leaves the honest question — did it touch my mail? — sitting
 * unanswered. The count of surviving emails is the answer, in the only unit the
 * user actually recognises.
 */

export interface CompactionResultLike {
  reclaimedBytes: number;
  beforeBytes: number;
  afterBytes: number;
  elapsedMs: number;
  emailCount: number | null;
  rowsPreserved: boolean;
  autoVacuumEnabled: boolean;
}

export interface CompactionSummary {
  text: string;
  tone: 'success' | 'warning';
}

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`;

export function summariseCompaction(result: CompactionResultLike): CompactionSummary {
  // Never expected — VACUUM is a lossless rebuild — but if the counts ever
  // disagree the user must hear it from the app rather than notice mail missing
  // days later. Reported ahead of the space saving, because it matters more.
  if (!result.rowsPreserved) {
    return {
      tone: 'warning',
      text:
        'The database was rebuilt, but the number of emails in it changed. ' +
        'Please check your mail and report this — your original file was replaced, ' +
        'so do not run this again on this account until it has been looked at.',
    };
  }

  const parts: string[] = [];

  if (result.reclaimedBytes > 0) {
    parts.push(
      `Freed ${formatBytes(result.reclaimedBytes)} — this database was ` +
        `${formatBytes(result.beforeBytes)} and is now ${formatBytes(result.afterBytes)} ` +
        `(took ${seconds(result.elapsedMs)}).`,
    );
  } else {
    // A rebuild that reclaimed nothing still succeeded; say so, rather than
    // leaving a spinner that stopped with no explanation.
    parts.push(
      `Rebuilt in ${seconds(result.elapsedMs)}. There was no wasted space left to ` +
        `reclaim, so the size is unchanged.`,
    );
  }

  parts.push(
    result.emailCount === null
      ? 'No mail was deleted or changed.'
      : `All ${result.emailCount.toLocaleString()} emails are still here — nothing was ` +
        `deleted or changed.`,
  );

  if (result.autoVacuumEnabled) {
    // Careful with this claim. INCREMENTAL auto-vacuum does NOT hand space back
    // on its own — it keeps the pointer maps that let freed pages be released
    // in bounded chunks later, without another full rebuild. Saying it
    // self-cleans would be a lie the user could check.
    parts.push('This database is now set up to reclaim space without a full rebuild next time.');
  }

  return { tone: 'success', text: parts.join(' ') };
}
