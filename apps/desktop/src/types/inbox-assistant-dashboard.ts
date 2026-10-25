import type { InboxAssistantAccount, InboxAssistantSource, InboxAssistantUsage } from './inbox-assistant';

/** Local, read-only overview. Loading widgets never invokes a model or changes mail. */
export interface InboxAssistantDashboard {
  generatedAt: number;
  accounts: Array<InboxAssistantAccount & { status: 'ready' | 'unavailable'; error?: string }>;
  counts: {
    unreadConversations: number | null;
    uncategorizedUnreadConversations: number | null;
    needsReplyConversations: number | null;
  };
  needsReply: { total: number | null; items: InboxAssistantSource[]; truncated: boolean };
  followUps: {
    total: number | null;
    items: Array<{ id: string; accountId: string; subject: string; to?: string; dueAt: number; source?: InboxAssistantSource }>;
    truncated: boolean;
  };
  meetings: {
    timeZone: string;
    scope: 'local-only';
    status: 'ready' | 'unavailable';
    items: Array<{ eventId: string; occurrenceId?: string; startMs: number; endMs: number; title: string; calendarName: string; allDay: boolean }>;
  };
  /** Optional recorded usage; unknown provider rates must remain unknown. */
  usage?: InboxAssistantUsage;
  warnings: string[];
}

export interface InboxAssistantDashboardRequest { accountIds: string[] }
