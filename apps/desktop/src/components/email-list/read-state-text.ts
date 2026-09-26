// How a thread's sender and subject read in the list, by read state — pure, so
// the contrast rule is tested without rendering a row. Shared by
// CompactThreadRow and ThreadCard so the two layouts can't drift apart.
//
// Weight alone does not mark a thread unread: in dark mode a semibold white
// subject beside a regular white one is nearly indistinguishable. So an unread
// thread is heavier AND full-contrast, and a read one drops to the muted tone.

/** Tailwind classes for a thread's sender and subject text. */
export const readStateTextClass = (hasUnread: boolean): string =>
  hasUnread ? 'font-semibold text-foreground' : 'text-muted-foreground';
