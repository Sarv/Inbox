export type ShortcutAction =
  | 'MOVE_DOWN'
  | 'MOVE_UP'
  | 'NEXT_EMAIL'
  | 'PREVIOUS_EMAIL'
  | 'OPEN_THREAD'
  | 'GO_BACK'
  | 'ESCAPE'
  | 'ARCHIVE'
  | 'DELETE'
  | 'SPAM'
  | 'STAR_TOGGLE'
  | 'MARK_READ'
  | 'MARK_UNREAD'
  | 'MARK_IMPORTANT'
  | 'MARK_NOT_IMPORTANT'
  | 'SNOOZE'
  | 'SHORTCUTS_HELP'
  | 'REPLY'
  | 'REPLY_ALL'
  | 'REPLY_ALL_POPUP'
  | 'FORWARD_INLINE'
  | 'FORWARD_POPUP'
  | 'COMPOSE'
  | 'FOCUS_SEARCH'
  | 'SELECT_TOGGLE'
  | 'UNDO_DELETE';

export type ShortcutCategory = 'Navigation' | 'Actions' | 'Compose' | 'Go To';

export interface ShortcutDef {
  keys: string[];
  shift?: boolean;
  action: ShortcutAction;
  label: string;
  description: string;
  category: ShortcutCategory;
}

export const DEFAULT_SHORTCUTS: ShortcutDef[] = [
  // Navigation
  { keys: ['j', 'ArrowDown'], action: 'MOVE_DOWN', label: 'Move Down', description: 'Next conversation in list, scroll down in detail', category: 'Navigation' },
  { keys: ['k', 'ArrowUp'], action: 'MOVE_UP', label: 'Move Up', description: 'Previous conversation in list, scroll up in detail', category: 'Navigation' },
  { keys: ['ArrowRight'], action: 'NEXT_EMAIL', label: 'Next Email', description: 'Navigate to next email thread', category: 'Navigation' },
  { keys: ['ArrowLeft'], action: 'PREVIOUS_EMAIL', label: 'Previous Email', description: 'Navigate to previous email thread', category: 'Navigation' },
  { keys: ['Enter', 'o'], action: 'OPEN_THREAD', label: 'Open Thread', description: 'Open selected conversation', category: 'Navigation' },
  { keys: ['u'], action: 'UNDO_DELETE', label: 'Undo Delete', description: 'Undo last email deletion', category: 'Actions' },
  { keys: ['Escape'], action: 'ESCAPE', label: 'Escape', description: 'Go to Inbox, close compose, clear search, or deselect', category: 'Navigation' },
  { keys: ['x'], action: 'SELECT_TOGGLE', label: 'Select', description: 'Toggle selection of conversation', category: 'Navigation' },

  // Actions
  { keys: ['e'], action: 'ARCHIVE', label: 'Archive', description: 'Archive selected email', category: 'Actions' },
  { keys: ['d', '#', 'Backspace', 'Delete'], action: 'DELETE', label: 'Delete', description: 'Move selected email to trash', category: 'Actions' },
  { keys: ['!'], action: 'SPAM', label: 'Report Spam', description: 'Mark as spam', category: 'Actions' },
  { keys: ['s'], action: 'STAR_TOGGLE', label: 'Star / Unstar', description: 'Toggle star on selected email', category: 'Actions' },
  { keys: ['I'], shift: true, action: 'MARK_READ', label: 'Mark as Read', description: 'Mark selected email as read', category: 'Actions' },
  { keys: ['U'], shift: true, action: 'MARK_UNREAD', label: 'Mark as Unread', description: 'Mark selected email as unread', category: 'Actions' },
  { keys: ['/'], action: 'FOCUS_SEARCH', label: 'Search', description: 'Focus the search bar', category: 'Actions' },
  { keys: ['b'], action: 'SNOOZE', label: 'Snooze', description: 'Snooze selected email', category: 'Actions' },
  { keys: ['+', '='], action: 'MARK_IMPORTANT', label: 'Mark Important', description: 'Mark selected email as important', category: 'Actions' },
  { keys: ['-'], action: 'MARK_NOT_IMPORTANT', label: 'Mark Not Important', description: 'Remove important from selected email', category: 'Actions' },
  { keys: ['?'], shift: true, action: 'SHORTCUTS_HELP', label: 'Keyboard Shortcuts', description: 'Show keyboard shortcuts help', category: 'Actions' },

  // Compose
  { keys: ['r', 'a'], action: 'REPLY_ALL', label: 'Reply All', description: 'Inline reply to all recipients', category: 'Compose' },
  { keys: ['1'], action: 'REPLY', label: 'Reply One', description: 'Inline reply to sender only', category: 'Compose' },
  { keys: ['R', 'A'], shift: true, action: 'REPLY_ALL_POPUP', label: 'Reply All (Popup)', description: 'Reply all in popup compose', category: 'Compose' },
  { keys: ['f'], action: 'FORWARD_INLINE', label: 'Forward', description: 'Inline forward selected email', category: 'Compose' },
  { keys: ['F'], shift: true, action: 'FORWARD_POPUP', label: 'Forward (Popup)', description: 'Forward in popup compose', category: 'Compose' },
  { keys: ['c'], action: 'COMPOSE', label: 'Compose', description: 'Start a new email', category: 'Compose' },
];

export type GotoTarget = 'inbox' | 'starred' | 'all' | 'sent' | 'drafts' | 'snoozed';

export interface GotoShortcutDef {
  keys: string[];
  target: GotoTarget;
  label: string;
  description: string;
}

export const DEFAULT_GOTO_SHORTCUTS: GotoShortcutDef[] = [
  { keys: ['i'], target: 'inbox', label: 'Inbox', description: 'Go to Inbox' },
  { keys: ['s'], target: 'starred', label: 'Starred', description: 'Go to Starred' },
  { keys: ['a'], target: 'all', label: 'All Mail', description: 'Go to All Mail' },
  { keys: ['t'], target: 'sent', label: 'Sent', description: 'Go to Sent Mail' },
  { keys: ['d'], target: 'drafts', label: 'Drafts', description: 'Go to Drafts' },
  { keys: ['b'], target: 'snoozed', label: 'Snoozed', description: 'Go to Snoozed' },
];

export const GOTO_TIMEOUT_MS = 1000;

// --- Custom bindings persistence ---

const CUSTOM_SHORTCUTS_KEY = 'sarvinbox-keyboard-shortcuts';

export interface CustomBindings {
  shortcuts?: Partial<Record<ShortcutAction, string[]>>;
  goto?: Partial<Record<GotoTarget, string[]>>;
}

export function loadCustomBindings(): CustomBindings {
  try {
    const stored = localStorage.getItem(CUSTOM_SHORTCUTS_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return {};
}

export function saveCustomBindings(bindings: CustomBindings): void {
  localStorage.setItem(CUSTOM_SHORTCUTS_KEY, JSON.stringify(bindings));
}

export function clearCustomBindings(): void {
  localStorage.removeItem(CUSTOM_SHORTCUTS_KEY);
}

export function getEffectiveShortcuts(): ShortcutDef[] {
  const custom = loadCustomBindings();
  if (!custom.shortcuts) return DEFAULT_SHORTCUTS;
  return DEFAULT_SHORTCUTS.map(def => {
    const override = custom.shortcuts?.[def.action];
    if (override) return { ...def, keys: override };
    return def;
  });
}

export function getEffectiveGotoShortcuts(): GotoShortcutDef[] {
  const custom = loadCustomBindings();
  if (!custom.goto) return DEFAULT_GOTO_SHORTCUTS;
  return DEFAULT_GOTO_SHORTCUTS.map(def => {
    const override = custom.goto?.[def.target];
    if (override) return { ...def, keys: override };
    return def;
  });
}

// Build Record<key, target> from effective goto shortcuts (all keys map to their target)
export function getEffectiveGotoRecord(): Record<string, GotoTarget> {
  const record: Record<string, GotoTarget> = {};
  for (const s of getEffectiveGotoShortcuts()) {
    for (const k of s.keys) {
      record[k] = s.target;
    }
  }
  return record;
}

// Pretty-print key names for UI display
export function prettyKey(key: string): string {
  const map: Record<string, string> = {
    ArrowDown: '↓',
    ArrowUp: '↑',
    ArrowLeft: '←',
    ArrowRight: '→',
    Escape: 'Esc',
    ' ': 'Space',
    Backspace: '⌫',
    Delete: 'Del',
    Tab: 'Tab',
  };
  return map[key] || key;
}

// Get formatted shortcut hints for a given action as an array (e.g. ["E"] for archive, ["Shift+I"] for mark read)
// Returns all unique display keys for the action.
export function getShortcutHints(action: ShortcutAction): string[] {
  const shortcuts = getEffectiveShortcuts();
  const def = shortcuts.find(s => s.action === action);
  if (!def) return [];

  const prefix = def.shift ? 'Shift+' : '';
  // Deduplicate display names (e.g. ArrowDown and j both show differently)
  const seen = new Set<string>();
  const result: string[] = [];
  for (const key of def.keys) {
    const display = `${prefix}${prettyKey(key)}`;
    if (!seen.has(display)) {
      seen.add(display);
      result.push(display);
    }
  }
  return result;
}

// Single string shorthand — returns just the first key
export function getShortcutHint(action: ShortcutAction): string {
  return getShortcutHints(action)[0] || '';
}

// Get formatted "Go To" shortcut hints — returns both the direct key and the g-prefix version
// e.g. for inbox → ["i", "g then i"]  (preserves original case)
export function getGotoShortcutHints(target: GotoTarget): string[] {
  const gotos = getEffectiveGotoShortcuts();
  const def = gotos.find(s => s.target === target);
  if (!def) return [];
  const key = prettyKey(def.keys[0]);
  return [key, `g then ${key}`];
}

// Single string shorthand
export function getGotoShortcutHint(target: GotoTarget): string {
  const key = getEffectiveGotoShortcuts().find(s => s.target === target)?.keys[0] || '';
  return `g then ${key}`;
}

// Platform-aware modifier key symbol
export const MOD_KEY = navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl';

// Legacy compat export
export const SINGLE_KEY_SHORTCUTS = DEFAULT_SHORTCUTS;
