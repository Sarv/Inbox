// Pure helpers for rendering mailbox storage quota. No imports — unit-testable
// without a DOM. Bytes in, a view model out (percent, severity, labels).

export type QuotaLevel = 'ok' | 'warning' | 'critical';

export interface QuotaView {
  percent: number;      // 0..100, clamped
  level: QuotaLevel;    // drives the bar color + whether we nag the user
  usedLabel: string;    // e.g. "3.2 GB"
  limitLabel: string;   // e.g. "15 GB"
  label: string;        // e.g. "3.2 GB of 15 GB (21%)"
}

/** Nearly-full thresholds — surfaced so tests pin the exact boundaries. */
export const QUOTA_WARN_PCT = 80;
export const QUOTA_CRITICAL_PCT = 95;

/**
 * Human-readable byte size with one decimal for GB/MB.
 *
 * Kept identical to `formatBytes` in `packages/core/src/utils/format-bytes.ts`,
 * which the main process uses. Not imported from there because the renderer
 * cannot load the core barrel at runtime (Node-only transitive deps) and the
 * package exposes no deep entry point. Change one, change both.
 */
export function formatBytes(bytes: number): string {
  const n = Math.max(0, bytes || 0);
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const KB = 1024;
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(n >= 10 * MB ? 0 : 1)} MB`;
  if (n >= KB) return `${Math.round(n / KB)} KB`;
  return `${Math.round(n)} B`;
}

/**
 * Build the quota view, or null when there's nothing meaningful to show (no
 * limit / unlimited). Percent is clamped to 100 so an over-quota mailbox doesn't
 * overflow the bar. Level escalates at QUOTA_WARN_PCT / QUOTA_CRITICAL_PCT.
 */
export function formatQuota(used: number, limit: number): QuotaView | null {
  if (!limit || limit <= 0) return null;
  const ratio = (used || 0) / limit;
  const percent = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  const level: QuotaLevel = percent >= QUOTA_CRITICAL_PCT ? 'critical' : percent >= QUOTA_WARN_PCT ? 'warning' : 'ok';
  const usedLabel = formatBytes(used);
  const limitLabel = formatBytes(limit);
  return { percent, level, usedLabel, limitLabel, label: `${usedLabel} of ${limitLabel} (${percent}%)` };
}

/** What the sidebar's storage row should render right now. */
export type QuotaRow =
  | { kind: 'hidden' }
  | { kind: 'placeholder' }
  | { kind: 'bar'; view: QuotaView };

/**
 * Decide the storage row's state, kept out of the component so it can be tested.
 *
 * The rule that matters: a figure we already have STAYS on screen while a fresh
 * lookup runs, so switching accounts (or a periodic refresh) never unmounts the
 * row and reflows the sidebar. A placeholder is only for the genuinely unknown —
 * this account has never answered — and `answered` counts a `null` answer, so a
 * server without the QUOTA extension settles on hidden instead of flashing a
 * placeholder at every refresh.
 */
export function quotaRowState(input: {
  quota: { used: number; limit: number } | null;
  loading: boolean;
  answered: boolean;
}): QuotaRow {
  const view = formatQuota(input.quota?.used ?? 0, input.quota?.limit ?? 0);
  if (view) return { kind: 'bar', view };
  return input.loading && !input.answered ? { kind: 'placeholder' } : { kind: 'hidden' };
}
