/**
 * Human-readable byte sizes.
 *
 * NOTE ON THE SECOND COPY: the renderer has its own identical `formatBytes` in
 * `apps/desktop/src/components/quota-format.ts` and deliberately does NOT import
 * this one. The renderer cannot import `@sarvinbox/core` at runtime — the barrel
 * transitively pulls Node-only modules (mailparser, imapflow, better-sqlite3)
 * and the bundle dies with "Dynamic require of stream" — and the package exposes
 * only its root entry, so a deep import is not available either. Keep the two in
 * step: same thresholds, same rounding, so a size never reads differently in the
 * settings panel than it does in a main-process message about the same file.
 */

/**
 * One decimal below 10 units, none above ("9.4 GB", "12 GB") — enough precision
 * to see a number move without pretending to a byte-level accuracy that a
 * page-rounded database size does not have.
 */
export function formatBytes(bytes: number): string {
  const safeBytes = Math.max(0, bytes || 0);
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const KB = 1024;
  if (safeBytes >= GB) return `${(safeBytes / GB).toFixed(safeBytes >= 10 * GB ? 0 : 1)} GB`;
  if (safeBytes >= MB) return `${(safeBytes / MB).toFixed(safeBytes >= 10 * MB ? 0 : 1)} MB`;
  if (safeBytes >= KB) return `${Math.round(safeBytes / KB)} KB`;
  return `${Math.round(safeBytes)} B`;
}
