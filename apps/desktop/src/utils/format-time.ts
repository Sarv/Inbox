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
