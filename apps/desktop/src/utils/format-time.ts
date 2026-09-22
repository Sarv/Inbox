/**
 * Format a snooze_until timestamp as a human-readable countdown.
 * @param snoozeUntil Unix timestamp in seconds
 * @returns e.g. "45m", "2h 15m", "2d 3h", or "Overdue"
 */
export function formatCountdown(snoozeUntil: number): string {
  const diffSec = snoozeUntil - Math.floor(Date.now() / 1000);
  if (diffSec <= 0) return 'Due now';

  const minutes = Math.floor(diffSec / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainHours = hours % 24;
    return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainMin = minutes % 60;
    return remainMin > 0 ? `${hours}h ${remainMin}m` : `${hours}h`;
  }
  return `${Math.max(1, minutes)}m`;
}

/**
 * Format a deadline as a live, second-by-second countdown — "4:32", "58s",
 * "1h 05m" — or 'Expired' once it has passed.
 *
 * Deliberately NOT `formatCountdown` above, which rounds to whole minutes
 * because a snooze that ends in 45 minutes does not need a ticking clock. This
 * one is for deadlines the user is racing: a verification code whose window is
 * measured in minutes, where "1m" for the last 60 seconds would be wrong for 59
 * of them.
 *
 * @param expiresAt UTC epoch MILLISECONDS (not seconds — the snooze helper
 *                  above takes seconds, and mixing them up silently yields a
 *                  countdown 1000x off)
 */
export function formatExpiryCountdown(expiresAt: number, now: number = Date.now()): string {
  const remainingMs = expiresAt - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 'Expired';

  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}
