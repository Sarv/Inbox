/** Merge account-local thread pages without splitting a conversation at a page boundary. */
export function pageThreadMatches<T extends { id: string; threadId?: string | null; accountId?: string | null; date?: number }>(
  matches: T[],
  limit: number,
  offset: number,
): T[] {
  const threads = new Map<string, { threadId: string; accountId: string; latestDate: number; rows: T[] }>();
  for (const row of matches) {
    const threadId = row.threadId || row.id;
    const accountId = row.accountId ?? '';
    const key = JSON.stringify([accountId, threadId]);
    const existing = threads.get(key);
    if (existing) {
      existing.rows.push(row);
      existing.latestDate = Math.max(existing.latestDate, row.date ?? 0);
    } else {
      threads.set(key, { threadId, accountId, latestDate: row.date ?? 0, rows: [row] });
    }
  }
  return [...threads.values()]
    .sort((a, b) => b.latestDate - a.latestDate || descending(a.threadId, b.threadId) || descending(a.accountId, b.accountId))
    .slice(offset, offset + limit)
    .flatMap(thread => thread.rows.sort((a, b) => (b.date ?? 0) - (a.date ?? 0) || descending(a.id, b.id)));
}

/** Match SQLite's case-sensitive ordering rather than locale-dependent collation. */
function descending(a: string, b: string): number {
  return a === b ? 0 : a < b ? 1 : -1;
}
