import { useEffect, useRef } from 'react';

import type { AppSection } from '../components/AppSidebar';
import {
  getEffectiveShortcuts,
  getEffectiveGotoRecord,
  GOTO_TIMEOUT_MS,
  type ShortcutAction,
  type GotoTarget,
} from '../config/keyboard-shortcuts';
import { useEmailStore } from '../store/email-store';

interface UseKeyboardShortcutsOptions {
  setActiveSection: (section: AppSection) => void;
  focusSearch: () => void;
}

// Next/prev-email navigation always opens a different thread and thus triggers
// a thread load + IMAP body fetch. OS key-repeat (holding the arrow) is
// swallowed for these so a held key can't flood the connection pool; discrete
// presses still navigate one step at a time. MOVE_DOWN/MOVE_UP are deliberately
// excluded — with a mail open they scroll the reading pane, where hold-to-repeat
// is the desired behavior.
const REPEAT_SUPPRESSED_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'NEXT_EMAIL',
  'PREVIOUS_EMAIL',
]);

function isKeyboardShortcutsEnabled(): boolean {
  try {
    const stored = localStorage.getItem('sarvinbox-settings');
    if (stored) {
      const settings = JSON.parse(stored);
      return settings.keyboardShortcuts !== false;
    }
  } catch { /* ignore */ }
  return true;
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function getActiveEmailId(): string | null {
  const state = useEmailStore.getState();
  return state.selectedEmailId || state.highlightedEmailId;
}

function getSelectedEmail() {
  const state = useEmailStore.getState();
  const { emails, searchResults, searchQuery } = state;
  const activeId = getActiveEmailId();
  const pool = searchQuery ? searchResults : emails;
  const email = activeId ? pool.find(e => e.id === activeId) : null;
  return email ?? null;
}

// Resolve the WHOLE conversation the active email belongs to, so a keyboard
// action on a highlighted/selected thread operates on every message (Gmail
// behaviour) — matching the detail toolbar and the list's row/bulk actions.
// Detail view open → the open thread (threadEmails); list view → the highlighted
// thread resolved from the navigation set. Falls back to the lone active id.
function getActiveThreadEmailIds(): string[] {
  const state = useEmailStore.getState();
  const activeId = state.selectedEmailId || state.highlightedEmailId;
  if (!activeId) return [];
  if (
    state.selectedEmailId &&
    state.threadEmails.length > 0 &&
    state.threadEmails.some(e => e.id === activeId)
  ) {
    return state.threadEmails.map(e => e.id);
  }
  const threads = state.getNavigationThreads();
  const thread = threads.find(
    t => t.threadId === activeId || t.emails.some((e: any) => e.id === activeId),
  );
  return thread ? thread.emails.map((e: any) => e.id) : [activeId];
}

function buildComposePayload(email: ReturnType<typeof getSelectedEmail>) {
  if (!email) return undefined;
  return {
    id: email.id,
    subject: email.subject || '',
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    toAddress: email.toAddress || '',
    ccAddress: email.ccAddress,
    date: email.date,
    cleanBody: email.cleanBody,
    rawBody: email.rawBody,
  };
}

export function useKeyboardShortcuts({ setActiveSection, focusSearch }: UseKeyboardShortcutsOptions) {
  const gotoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitingForGotoRef = useRef(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isKeyboardShortcutsEnabled()) return;

      const isEscape = e.key === 'Escape';

      // Skip when typing in inputs (except Escape)
      if (!isEscape && isTypingTarget(e.target)) return;

      // Skip when meta/ctrl/alt are held (except for Shift which we handle explicitly)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Handle "g" prefix for go-to sequences
      if (!waitingForGotoRef.current && e.key === 'g' && !e.shiftKey) {
        if (isTypingTarget(e.target)) return;
        waitingForGotoRef.current = true;
        if (gotoTimerRef.current) clearTimeout(gotoTimerRef.current);
        gotoTimerRef.current = setTimeout(() => {
          console.log('[Shortcuts] Go-to mode timed out');
          waitingForGotoRef.current = false;
        }, GOTO_TIMEOUT_MS);
        console.log('[Shortcuts] Go-to mode activated — press target key within 1s');
        e.preventDefault();
        return;
      }

      // Complete go-to sequence
      if (waitingForGotoRef.current) {
        waitingForGotoRef.current = false;
        if (gotoTimerRef.current) {
          clearTimeout(gotoTimerRef.current);
          gotoTimerRef.current = null;
        }

        const gotoRecord = getEffectiveGotoRecord();
        const target: GotoTarget | undefined = gotoRecord[e.key];
        console.log('[Shortcuts] Go-to key:', e.key, '→ target:', target || '(no match)');
        if (target) {
          e.preventDefault();
          handleGoto(target);
        }
        return;
      }

      // Match single-key shortcuts (multi-key aware)
      const shortcuts = getEffectiveShortcuts();
      const match = shortcuts.find(s => {
        if (s.shift && !e.shiftKey) return false;
        if (!s.shift && e.shiftKey) {
          // Allow shift for keys that naturally require it (# = Shift+3, ! = Shift+1, + = Shift+=)
          if (!['#', '!', '+'].includes(e.key)) return false;
        }
        return s.keys.includes(e.key);
      });

      if (match) {
        // Escape always works, even in inputs
        if (match.action !== 'ESCAPE' && isTypingTarget(e.target)) return;

        // Prevent default for special keys
        if (
          match.action === 'FOCUS_SEARCH' || match.action === 'ESCAPE' || match.action === 'SHORTCUTS_HELP' ||
          match.action === 'MOVE_DOWN' || match.action === 'MOVE_UP' ||
          match.action === 'NEXT_EMAIL' || match.action === 'PREVIOUS_EMAIL' ||
          match.action === 'DELETE'
        ) {
          e.preventDefault();
        }

        // Swallow OS key-repeat for mail navigation. Holding an arrow key emits
        // dozens of keydowns/sec; each one selects an email and schedules a
        // thread load + IMAP body fetch with no cancellation, so a held key
        // floods the single connection pool and wedges the app. Discrete
        // presses (e.repeat === false) still navigate one step at a time.
        if (e.repeat && REPEAT_SUPPRESSED_ACTIONS.has(match.action)) {
          return;
        }

        handleAction(match.action);
        return;
      }

      // Direct single-key goto (no "g" prefix needed)
      const gotoRecord = getEffectiveGotoRecord();
      const directGoto: GotoTarget | undefined = gotoRecord[e.key];
      if (directGoto) {
        e.preventDefault();
        handleGoto(directGoto);
      }
    };

    const getCurrentThreadIndex = (threads: import('../utils/thread-utils').EmailThread[]) => {
      const state = useEmailStore.getState();
      const activeId = state.selectedEmailId || state.highlightedEmailId;
      if (!activeId) return -1;
      return threads.findIndex(t =>
        t.threadId === activeId || t.emails.some((e: any) => e.id === activeId)
      );
    };

    const selectThreadAt = (
      threads: import('../utils/thread-utils').EmailThread[],
      idx: number,
      isDetail: boolean,
    ) => {
      const thread = threads[idx];
      if (!thread) return;
      const emailToSelect = thread.firstUnreadEmail || thread.latestEmail;
      if (isDetail) {
        // Detail view open — open the next/previous thread
        useEmailStore.getState().selectEmail(emailToSelect.id);
      } else {
        // List view — just highlight, don't open detail
        useEmailStore.setState({ highlightedEmailId: emailToSelect.id });
      }
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-thread-id="${thread.threadId}"]`);
        el?.scrollIntoView({ block: 'nearest' });
      });
    };

    const handleNavigation = async (direction: 1 | -1) => {
      const store = useEmailStore.getState();
      const threads = store.getNavigationThreads();
      if (threads.length === 0) return;

      const currentIdx = getCurrentThreadIndex(threads);
      const isDetail = !!store.selectedEmailId;

      if (currentIdx === -1) {
        // Nothing selected — pick first or last depending on direction
        selectThreadAt(threads, direction === 1 ? 0 : threads.length - 1, isDetail);
        return;
      }

      const nextIdx = currentIdx + direction;

      // Within the currently-loaded page — just move.
      if (nextIdx >= 0 && nextIdx < threads.length) {
        selectThreadAt(threads, nextIdx, isDetail);
        return;
      }

      // Past a page boundary. In the LIST view we STOP: the list is paginated
      // (Gmail-style, 50/page) and paging is the Paginator's ‹ › job — arrow
      // keys must never auto-load (that grew the DOM unbounded and made the
      // list unresponsive). In the DETAIL view we page through transparently so
      // Left/Right walks the entire folder 1..N. The sectioned INBOX and search
      // have no single linear page to cross, so they stop too.
      if (!isDetail || store.usesSectionNav() || store.searchQuery) return;

      if (direction === 1) {
        if (!store.hasMoreEmails) return;   // already at the last mail
        await store.goToEmailPage(store.emailsPage + 1);
      } else {
        if (store.emailsPage <= 0) return;  // already at the first mail
        await store.goToEmailPage(store.emailsPage - 1);
      }

      // New page loaded (rows replaced) — land on its first (forward) or last
      // (backward) thread so navigation continues without a gap.
      const next = useEmailStore.getState().getNavigationThreads();
      selectThreadAt(next, direction === 1 ? 0 : next.length - 1, true);
    };

    const handleGoto = (target: GotoTarget) => {
      const store = useEmailStore.getState();
      setActiveSection('mail');

      switch (target) {
        case 'inbox': {
          const inboxFolder = store.folders.find(f => f.path === 'INBOX');
          if (inboxFolder) {
            // selectFolder clears virtual / snoozed / AI category itself.
            // Pre-clearing here would null those flags before selectFolder's
            // skip-reload check sees them, leaving the filtered email list
            // on screen.
            store.selectFolder(inboxFolder.id);
          }
          break;
        }
        case 'starred': {
          store.clearSnoozedView();
          store.clearAICategoryView();
          store.loadStarredEmails();
          break;
        }
        case 'all': {
          store.clearSnoozedView();
          store.clearAICategoryView();
          store.loadAllEmails();
          break;
        }
        case 'sent': {
          const sentFolder = store.folders.find(
            f => f.path === '[Gmail]/Sent Mail' ||
              f.path.toLowerCase() === 'sent' ||
              f.path === 'Sent Items'
          );
          if (sentFolder) {
            // See 'inbox' case — selectFolder handles all filter clearing.
            store.selectFolder(sentFolder.id);
          }
          break;
        }
        case 'drafts': {
          const draftsFolder = store.folders.find(
            f => f.path === '[Gmail]/Drafts' ||
              f.path.toLowerCase() === 'drafts' ||
              f.path === 'Draft'
          );
          if (draftsFolder) {
            store.selectFolder(draftsFolder.id);
          }
          break;
        }
        case 'snoozed': {
          store.clearAICategoryView();
          store.loadSnoozedEmails();
          break;
        }
      }
    };

    const handleAction = (action: ShortcutAction) => {
      const store = useEmailStore.getState();

      switch (action) {
        case 'MOVE_DOWN':
        case 'MOVE_UP':
          if (store.selectedEmailId) {
            // Detail view open — scroll the email content
            const detailPane = document.querySelector('[data-email-detail-scroll]');
            if (detailPane) {
              detailPane.scrollBy({ top: action === 'MOVE_DOWN' ? 200 : -200, behavior: 'smooth' });
            }
          } else {
            // List view — navigate between threads
            handleNavigation(action === 'MOVE_DOWN' ? 1 : -1);
          }
          break;

        case 'NEXT_EMAIL':
        case 'PREVIOUS_EMAIL':
          if (store.selectedEmailId) {
            // Detail view — navigate to next/previous thread
            handleNavigation(action === 'NEXT_EMAIL' ? 1 : -1);
          }
          break;

        case 'OPEN_THREAD': {
          if (store.selectedEmailId) {
            // Already viewing detail — no-op
          } else {
            // Open highlighted or first thread
            const activeId = getActiveEmailId();
            if (activeId) {
              store.selectEmail(activeId);
            } else {
              const threads = store.getNavigationThreads();
              if (threads.length > 0) {
                const emailToSelect = threads[0].firstUnreadEmail || threads[0].latestEmail;
                store.selectEmail(emailToSelect.id);
              }
            }
          }
          break;
        }

        case 'GO_BACK':
          store.selectEmail(null as any);
          break;

        case 'ESCAPE':
          // Close compose > clear search > deselect > go to inbox
          if (store.compose.isOpen) {
            store.closeCompose();
          } else if (store.searchQuery) {
            store.clearSearch?.();
          } else if (store.selectedEmailId) {
            store.selectEmail(null as any);
          } else {
            // Nothing open — go to Inbox
            handleGoto('inbox');
          }
          break;

        case 'ARCHIVE': {
          // Archive the WHOLE conversation, not just the highlighted message.
          const ids = getActiveThreadEmailIds();
          if (ids.length === 0) break;
          if (ids.length === 1) store.archiveEmail(ids[0]);
          else store.bulkRemoveEmails(ids, 'archive');
          break;
        }

        case 'DELETE': {
          // Delete the WHOLE conversation (move every message to trash). One
          // bulkRemoveEmails call for multi-message threads; the per-message
          // path (undo toast + auto-advance) is kept for a single-message thread.
          const ids = getActiveThreadEmailIds();
          if (ids.length === 0) break;
          if (ids.length === 1) store.deleteEmail(ids[0]);
          else store.bulkRemoveEmails(ids, 'delete');
          break;
        }

        case 'SPAM': {
          // Report the WHOLE conversation as spam.
          const ids = getActiveThreadEmailIds();
          if (ids.length === 0) break;
          if (ids.length === 1) store.moveToSpam(ids[0]);
          else store.bulkRemoveEmails(ids, 'spam');
          break;
        }

        case 'STAR_TOGGLE': {
          // Direction from the representative message; apply across the thread.
          const email = getSelectedEmail();
          if (!email) break;
          const isStarred = (email.tags || '').includes('|starred|');
          const ids = getActiveThreadEmailIds();
          store.bulkMarkStarred(ids, !isStarred);
          break;
        }

        case 'MARK_READ': {
          const ids = getActiveThreadEmailIds();
          if (ids.length === 0) break;
          store.bulkMarkRead(ids, true);
          break;
        }

        case 'MARK_UNREAD': {
          const ids = getActiveThreadEmailIds();
          if (ids.length === 0) break;
          store.bulkMarkRead(ids, false);
          if (store.selectedEmailId) store.clearSelectedEmail();
          break;
        }

        case 'REPLY': {
          const activeId = getActiveEmailId();
          if (activeId) {
            if (!store.selectedEmailId) store.selectEmail(activeId);
            setTimeout(() => {
              document.dispatchEvent(
                new CustomEvent('sarvinbox:inline-reply', { detail: { mode: 'reply' } })
              );
            }, 50);
          }
          break;
        }

        case 'REPLY_ALL': {
          const activeId = getActiveEmailId();
          if (activeId) {
            if (!store.selectedEmailId) store.selectEmail(activeId);
            setTimeout(() => {
              document.dispatchEvent(
                new CustomEvent('sarvinbox:inline-reply', { detail: { mode: 'replyAll' } })
              );
            }, 50);
          }
          break;
        }

        case 'REPLY_ALL_POPUP': {
          const email = getSelectedEmail();
          if (email) {
            store.openCompose('replyAll', buildComposePayload(email));
          }
          break;
        }

        case 'FORWARD_INLINE': {
          const activeId = getActiveEmailId();
          if (activeId) {
            if (!store.selectedEmailId) store.selectEmail(activeId);
            setTimeout(() => {
              document.dispatchEvent(
                new CustomEvent('sarvinbox:inline-forward')
              );
            }, 50);
          }
          break;
        }

        case 'FORWARD_POPUP': {
          const email = getSelectedEmail();
          if (email) {
            store.openCompose('forward', buildComposePayload(email));
          }
          break;
        }

        case 'COMPOSE':
          store.openCompose('new');
          break;

        case 'SNOOZE': {
          const emailId = getActiveEmailId();
          if (emailId) {
            document.dispatchEvent(
              new CustomEvent('sarvinbox:open-snooze', { detail: { emailId } })
            );
          }
          break;
        }

        case 'MARK_IMPORTANT': {
          const email = getSelectedEmail();
          if (email) {
            const isImportant = (email.tags || '').includes('|important|');
            if (!isImportant) store.markImportant(email.id, true);
          }
          break;
        }

        case 'MARK_NOT_IMPORTANT': {
          const email = getSelectedEmail();
          if (email) {
            const isImportant = (email.tags || '').includes('|important|');
            if (isImportant) store.markImportant(email.id, false);
          }
          break;
        }

        case 'SHORTCUTS_HELP':
          document.dispatchEvent(new CustomEvent('sarvinbox:shortcuts-help'));
          break;

        case 'FOCUS_SEARCH':
          focusSearch();
          break;

        case 'SELECT_TOGGLE': {
          const threads = store.getNavigationThreads();
          const currentIdx = getCurrentThreadIndex(threads);
          if (currentIdx >= 0) {
            document.dispatchEvent(
              new CustomEvent('sarvinbox:toggle-thread-selection', {
                detail: { threadId: threads[currentIdx].threadId },
              })
            );
          }
          break;
        }

        case 'UNDO_DELETE': {
          // Undo send takes priority if there's a pending send
          if (store.pendingSend) {
            store.undoSend();
          } else if (store.pendingDeletes.length > 0) {
            // Undo the most recent delete (no arg = last in array)
            store.undoDelete();
          }
          break;
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (gotoTimerRef.current) clearTimeout(gotoTimerRef.current);
    };
  }, [setActiveSection, focusSearch]);
}
