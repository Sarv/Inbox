// Quick search suggestions shown when the search bar is focused.
// Lives outside AdvancedSearchPanel.tsx so that component file only
// exports React components — mixing a const export in breaks Vite's
// Fast Refresh for the whole module (hmr invalidate on every edit).
import type { ViewFilter } from '@sarvinbox/core';
import { Paperclip, Send, Star, Mail, MailOpen, Tag } from 'lucide-react';


export const QUICK_SEARCH_SUGGESTIONS = [
  { label: 'Unread', query: 'is:unread', icon: Mail },
  { label: 'Starred', query: 'is:starred', icon: Star },
  { label: 'Has attachment', query: 'has:attachment', icon: Paperclip },
  { label: 'From me', query: 'from:me', icon: Send },
  { label: 'Sent', query: 'in:sent', icon: Send },
  { label: 'Read', query: 'is:read', icon: MailOpen },
  { label: 'Unlabelled', query: 'is:unlabelled', icon: Tag },
];

// The subset of quick filters that map cleanly to a ViewFilter and therefore
// narrow the EXISTING sectioned inbox (kept in the sectioned layout, paginated)
// instead of running a flat text search. Keyed by the exact chip query string so
// only a bare filter click routes here — "is:unread meeting" still text-searches.
export const INBOX_QUICK_FILTERS: Record<string, { filter: ViewFilter; label: string }> = {
  'is:unread': { filter: { isUnread: true }, label: 'Unread' },
  'is:read': { filter: { isUnread: false }, label: 'Read' },
  'is:starred': { filter: { isFlagged: true }, label: 'Starred' },
  'has:attachment': { filter: { hasAttachments: true }, label: 'Has attachment' },
  'is:unlabelled': { filter: { noCategory: true }, label: 'Unlabelled' },
};
