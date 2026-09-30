// Shared inbox types and constants
// Used by EmailList.tsx, Settings.tsx, and the Zustand store

export type InboxType = 'default' | 'important_first' | 'unread_first' | 'priority_first';

export type SectionFilter =
  | 'important_unread'
  | 'important'
  | 'unread'
  | 'starred'
  | 'everything_else'
  | 'none';

export interface InboxSection {
  id: string;
  filter: SectionFilter;
  maxItems: number;
  hideWhenEmpty: boolean;
}

export const DEFAULT_SECTIONS: Record<string, InboxSection[]> = {
  important_first: [
    { id: 'section-1', filter: 'important', maxItems: 0, hideWhenEmpty: false },
    { id: 'section-2', filter: 'everything_else', maxItems: 0, hideWhenEmpty: false },
  ],
  unread_first: [
    { id: 'section-1', filter: 'unread', maxItems: 0, hideWhenEmpty: false },
    { id: 'section-2', filter: 'everything_else', maxItems: 0, hideWhenEmpty: false },
  ],
  priority_first: [
    { id: 'section-1', filter: 'important_unread', maxItems: 0, hideWhenEmpty: false },
    { id: 'section-2', filter: 'starred', maxItems: 0, hideWhenEmpty: true },
    { id: 'section-3', filter: 'everything_else', maxItems: 0, hideWhenEmpty: false },
  ],
};

export const SECTION_FILTER_LABELS: Record<SectionFilter, string> = {
  important_unread: 'Important and unread',
  important: 'Important',
  unread: 'Unread',
  starred: 'Starred',
  everything_else: 'Everything else',
  none: 'None (hide section)',
};

export const SETTINGS_KEY = 'sarvinbox-settings';

/**
 * Fired on `window` after this window writes the {@link SETTINGS_KEY} blob
 * (bootstrap/app-settings-sync's write mirror), so a reader that keeps a parsed
 * copy in memory — the remote-image mode — re-reads it only when it may have
 * changed, instead of re-parsing the whole blob (signatures and all) per read.
 * Another window's write arrives as the ordinary `storage` event.
 */
export const SETTINGS_WRITTEN_EVENT = 'sarvinbox:settings-written';
