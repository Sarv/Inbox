import prettyBytes from 'pretty-bytes';
import { useState, useEffect, useRef, useMemo } from 'react';

import { isDraftsFolder } from '../../../config/folder-mapping';
import { detectSignature, type SignatureDetectionResult, getDefaultProvider } from '../../../services/ai-service';
import { extractConversation, isConversationModeEnabled, isAutoChatViewEnabled, reExtractSingleMessage, hasQuotedHistory, hasEmbeddedConversation, aiSplitFirstEmail, saveConversationCache, EXTRACTION_VERSION, EXTRACTED_MATCH_TOLERANCE_S, type ConversationMessage, type ConversationProgress } from '../../../services/conversation-service';
import { populateCacheFromHtml } from '../../../services/image-cache';
import { useEmailStore } from '../../../store/email-store';
import { collapseDuplicateMessages } from '../../../utils/duplicate-messages';
import { isDraftEmail, isDraftRow } from '../../../utils/thread-utils';
import type { EmailDetailContext } from '../types';
import {
  getInitials,
  getAvatarColor,
  parseAttachments,
  pendingSendThreadKeys,
  shouldSuppressDraftAutoOpen,
  threadKeysOf,
} from '../utils';

/**
 * Subject to use when opening a draft into the reply composer. Keeps the draft's
 * own subject when it has one; otherwise derives the conversation's `Re:` subject
 * from the parent message (so blank-subject drafts stop showing "(no subject)"
 * in the list and don't send with an empty subject).
 */
function replySubjectFor(draftSubject?: string | null, parentSubject?: string | null): string {
  const own = (draftSubject || '').trim();
  if (own) return own;
  const parent = (parentSubject || '').trim();
  if (!parent) return '';
  return parent.toLowerCase().startsWith('re:') ? parent : `Re: ${parent}`;
}

export function useEmailDetail(): EmailDetailContext | null {
  const {
    emails,
    folders,
    selectedFolderId,
    selectedEmailId,
    selectEmail,
    threadEmails: rawThreadEmails,
    loadingThread,
    markAsRead,
    deleteEmail,
    archiveEmail,
    bulkRemoveEmails,
    moveToSpam,
    moveFromSpam,
    clearSelectedEmail,
    manuallyMarkedUnreadId,
    openCompose,
    editDraftInComposer,
    searchResults,
    searchQuery,
    viewingAICategory,
    aiBoxActiveTab,
    setEmails,
    fetchEmailBody,
    loadingBodies,
    failedBodies,
    snoozeEmail,
    unsnoozeEmail,
    markAsStarred,
    setEmailLabel,
    restoreDraft,
    clearRestoreDraft,
  } = useEmailStore();

  // The Drafts folder path(s) for this account — lets isDraftEmail catch
  // provider-specific paths (e.g. `INBOX.Drafts`), not just the `|draft|`
  // marker. Recomputed only when the folder list changes.
  const draftFolderPaths = useMemo(
    () => new Set((folders || []).filter((f: any) => isDraftsFolder(f)).map((f: any) => f.path)),
    [folders]
  );

  // Exclude drafts from the thread transcript — Gmail-style, a draft is never a
  // static message; it's shown as an editable compose box at the bottom while
  // the rest of the conversation stays fully visible above it. This catches BOTH
  // our local mirror rows (tagged `|draft|`) AND drafts that came back from an
  // IMAP re-sync tagged only with their Drafts folder path (which the old
  // `|draft|`-only filter missed, so they leaked in as read-only messages
  // showing the signature as "content").
  const allThreadEmails = useMemo(
    // `isDraftRow`, not `isDraftEmail`: the latter answers "may I edit this?"
    // and says no once a draft is in Trash, so DELETING a draft made it appear
    // here as an ordinary message. Reported from the field.
    () => rawThreadEmails.filter(e => !isDraftRow(e, draftFolderPaths)),
    [rawThreadEmails, draftFolderPaths]
  );

  // Fold byte-identical copies of the same message behind one row. Dual
  // delivery (Sarv also delivering to Gmail) plus the migration that merged the
  // Gmail side back left real, distinct server messages that are the SAME mail
  // sitting next to each other in a thread — up to seven of one message in the
  // Acme integration thread. Render-only: `allThreadEmails` below still carries
  // every copy so marking the thread read reaches the hidden ones too.
  const duplicateGroups = useMemo(
    () => collapseDuplicateMessages(allThreadEmails, selectedEmailId),
    [allThreadEmails, selectedEmailId]
  );
  const threadEmails = useMemo(() => duplicateGroups.map(g => g.email), [duplicateGroups]);
  const duplicatesByEmailId = useMemo(
    () => new Map(duplicateGroups.filter(g => g.duplicates.length > 0).map(g => [g.email.id, g.duplicates])),
    [duplicateGroups]
  );
  // The conversation's REAL size — every copy, not just the visible rows. The
  // list row counts rows in the DB (THREAD_MESSAGE_COUNT_SQL) and cannot fold
  // duplicates (list rows carry a snippet, never `rawBody`), so a header built
  // from the collapsed `threadEmails` read as mail gone missing: the list
  // promised (3), the opened thread said (2). The fold is render-only, so the
  // count stays whole and the `N copies` badge explains the shorter card list.
  const threadMessageTotal = allThreadEmails.length;

  const [showFullHeaders, setShowFullHeaders] = useState(false);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());
  const [showFullContent, setShowFullContent] = useState<Set<string>>(new Set());
  const [mainEmailExpanded, setMainEmailExpanded] = useState(false);
  const [showInlineReply, setShowInlineReply] = useState(false);
  const [inlineReplyMode, setInlineReplyMode] = useState<'reply' | 'replyAll'>('reply');
  const [replyingToEmail, setReplyingToEmail] = useState<any | null>(null);
  const [inlineReplyDraft, setInlineReplyDraft] = useState<{ to: string; cc: string; subject?: string; htmlContent: string; attachments: any[]; draftMessageId?: string; isAIDraft?: boolean; aiReasoning?: string; agentDecisionId?: string } | undefined>(undefined);
  const inlineReplyHandlerRef = useRef<(mode: 'reply' | 'replyAll') => void>(() => { });
  const [showInlineForward, setShowInlineForward] = useState(false);
  const [forwardingEmail, setForwardingEmail] = useState<any | null>(null);
  const [inlineForwardDraft, setInlineForwardDraft] = useState<{ to: string; cc: string; htmlContent: string; attachments: any[] } | undefined>(undefined);
  const inlineForwardHandlerRef = useRef<() => void>(() => { });
  const [chatViewEnabled, setChatViewEnabled] = useState(() =>
    isAutoChatViewEnabled() && isConversationModeEnabled() && !!getDefaultProvider()
  );
  // True once the user EXPLICITLY toggled chat on for the current email. Lets a
  // single designed/transactional email (forwarded newsletter, alert) default to
  // Standard — chat-ifying its bespoke layout adds nothing — while still honoring
  // a manual switch. Reset per email. (Genuine multi-message threads and text
  // "loop-me-in" forwards still auto-open chat.)
  const [chatManuallyEnabled, setChatManuallyEnabled] = useState(false);
  const [conversationMessages, setConversationMessages] = useState<ConversationMessage[] | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationUpdating, setConversationUpdating] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [conversationPartial, setConversationPartial] = useState(false);
  // T6 — progressive-extraction counters for the UI (shape is frozen:
  // { done, total, status? } | null). Non-null only while an extraction
  // run is in flight; reset to null when it settles or the thread
  // changes.
  const [conversationProgress, setConversationProgress] = useState<{ done: number; total: number; status?: string } | null>(null);
  // Default to Standard (deterministic, no LLM) when a thread opens in chat
  // view; the user can switch to AI View on demand.
  const [showAIView, setShowAIView] = useState(false);
  const scheduledAutoReadRef = useRef<Set<string>>(new Set());
  // Defensive loop-breaker: how many times we've fired an auto-read for an email
  // in the CURRENT selection. If a mark-read keeps failing (e.g. the row's tags
  // revert to unread), the effect would otherwise re-arm forever. Capped per
  // selection; reset when the selected email changes.
  const autoReadAttemptsRef = useRef<Map<string, number>>(new Map());
  const bodyRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bodyRetryCountRef = useRef(0);

  const [showSignatures, setShowSignatures] = useState<Set<string>>(new Set());
  const [showOriginalEmail, setShowOriginalEmail] = useState<any | null>(null);
  const [signatureDetectionEmail, setSignatureDetectionEmail] = useState<any | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [signatureDetectionResult, setSignatureDetectionResult] = useState<SignatureDetectionResult | null>(null);
  const [signatureDetecting, setSignatureDetecting] = useState(false);

  // Check emails, searchResults, and threadEmails for the selected email
  // (Falling back to threadEmails prevents the UI from unmounting if a background sync replaces the active `emails` array)
  const selectedEmail = emails.find((e) => e.id === selectedEmailId)
    || (searchQuery ? searchResults.find((e) => e.id === selectedEmailId) : undefined)
    || threadEmails.find((e) => e.id === selectedEmailId);

  // When the selected email is itself a draft (opened from the Drafts folder or
  // the All view), it must NOT be rendered as a message — it becomes the compose
  // box. Anchor the view on the real conversation instead so the full thread is
  // visible above the draft box (Gmail behavior). Only when there is no real
  // conversation (a standalone draft) do we fall back to the draft itself.
  const selectedIsDraft = selectedEmail ? isDraftEmail(selectedEmail, draftFolderPaths) : false;

  // For thread display, show OLDEST email as main card (chronological order)
  const displayEmail = (() => {
    if (!selectedEmail) return selectedEmail;
    if (selectedIsDraft) {
      if (threadEmails.length === 0) return selectedEmail; // standalone draft
      return [...threadEmails].sort((a, b) => a.date - b.date)[0];
    }
    if (threadEmails.length <= 1) return selectedEmail;
    return [...threadEmails].sort((a, b) => a.date - b.date)[0];
  })();

  // Latest email in the thread — used as default reply target
  const latestThreadEmail = (() => {
    if (!selectedEmail) return selectedEmail;
    if (selectedIsDraft) {
      if (threadEmails.length === 0) return selectedEmail; // standalone draft
      return [...threadEmails].sort((a, b) => b.date - a.date)[0];
    }
    if (threadEmails.length <= 1) return selectedEmail;
    return [...threadEmails].sort((a, b) => b.date - a.date)[0];
  })();

  // A draft with no surrounding conversation (opened from the Drafts folder or
  // the All view, or a reply-draft that became its own thread): it IS the
  // compose box, so the read-only message card must not be rendered for it.
  const isStandaloneDraft = selectedIsDraft && threadEmails.length === 0;

  const isRead = (selectedEmail?.tags || '').includes('|read|') || !selectedEmail;

  // Stable primitives for the auto-read effect deps. Depending on the whole
  // `selectedEmail`/`threadEmails` objects re-ran the effect (and reset its 3s
  // timer) on EVERY store update — body streaming in, background sync, section
  // rebuild — so a heavy email (e.g. a calendar invite whose body loads async)
  // never stayed still for 3s and never got marked read. These keys change only
  // when the actual read/expanded state changes.
  const selectedEmailUnread = !!selectedEmail && !(selectedEmail.tags || '').includes('|read|');
  const expandedUnreadKey = threadEmails
    .filter(e => e.id !== selectedEmailId && expandedThreads.has(e.id) && !(e.tags || '').includes('|read|'))
    .map(e => e.id)
    .sort()
    .join(',');

  // Auto-mark the selected + any expanded unread emails as read immediately on
  // open (previously a 3s dwell timer). Fast arrow-scrolling marks each opened
  // mail read "on the go"; the already-read re-check below avoids a redundant
  // second markAsRead after the whole-thread-on-open pass.
  useEffect(() => {
    // Guard against stale data mid-navigation. selectEmail() now clears
    // threadEmails synchronously for cross-thread selections it can
    // resolve (emails-slice), which also kills the stale-thread content
    // flash in displayEmail — but a selection it CAN'T resolve (email
    // not in emails/searchResults) still leaves the previous thread's
    // rows here until loadThread lands, and expandedThreads is hook
    // state that resets asynchronously either way. Scheduling against
    // those rows would auto-read emails the user just navigated away
    // from.
    if (
      selectedEmailId &&
      threadEmails.length > 0 &&
      !threadEmails.some(e => e.id === selectedEmailId)
    ) {
      return;
    }

    const unreadExpandedEmails: string[] = [];

    if (selectedEmail && mainEmailExpanded && !(selectedEmail.tags || '').includes('|read|')) {
      if (manuallyMarkedUnreadId !== selectedEmail.id) {
        unreadExpandedEmails.push(selectedEmail.id);
      }
    }

    threadEmails.forEach((email) => {
      if (email.id !== selectedEmailId && expandedThreads.has(email.id) && !(email.tags || '').includes('|read|')) {
        if (manuallyMarkedUnreadId !== email.id) {
          unreadExpandedEmails.push(email.id);
        }
      }
    });

    const MAX_AUTO_READ_ATTEMPTS = 2; // defensive loop-breaker (see ref comment)
    const newUnreadEmails = unreadExpandedEmails.filter(
      id => !scheduledAutoReadRef.current.has(id)
        && (autoReadAttemptsRef.current.get(id) ?? 0) < MAX_AUTO_READ_ATTEMPTS,
    );

    if (newUnreadEmails.length === 0) return;

    console.log('[EmailDetail] Scheduling immediate auto-read for NEW emails:', newUnreadEmails);
    newUnreadEmails.forEach(id => scheduledAutoReadRef.current.add(id));

    const timerEmailIds = [...newUnreadEmails];
    const timer = setTimeout(async () => {
      try {
        const currentState = useEmailStore.getState();
        for (const emailId of timerEmailIds) {
          // Skip if it's already read — the 1.5s "mark whole thread read on
          // open" timer marks the opened email first (optimistic local update),
          // so without this the 3s timer fires a second, redundant markAsRead
          // (and IMAP round-trip) for the same email.
          const email = (currentState.emails || []).find(e => e.id === emailId)
            || (currentState.searchResults || []).find(e => e.id === emailId);
          const alreadyRead = !!email && (email.tags || '').includes('|read|');
          if (!alreadyRead && currentState.manuallyMarkedUnreadId !== emailId) {
            console.log('[EmailDetail] Auto-marking as read:', emailId);
            autoReadAttemptsRef.current.set(emailId, (autoReadAttemptsRef.current.get(emailId) ?? 0) + 1);
            await markAsRead(emailId, true);
          }
          scheduledAutoReadRef.current.delete(emailId);
        }
        console.log('[EmailDetail] Auto-read completed for:', timerEmailIds);
      } catch (error) {
        console.error('[EmailDetail] Failed to auto-mark as read:', error);
        timerEmailIds.forEach(id => scheduledAutoReadRef.current.delete(id));
      }
    }, 0);

    return () => {
      // Cancel the pending timer on dep change/navigation — otherwise it
      // fires ~3s later against the NEW selection state (selectEmail
      // resets manuallyMarkedUnreadId, so an email the user just marked
      // unread in the previous thread would get auto-marked read).
      // Un-schedule the ids so a re-run can re-arm for emails that are
      // still visible.
      clearTimeout(timer);
      timerEmailIds.forEach(id => scheduledAutoReadRef.current.delete(id));
    };
    // Deliberately depends on STABLE primitives (not the selectedEmail/
    // threadEmails objects) so async body streaming / background syncs don't
    // perpetually reset the 3s timer. eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEmailId, selectedEmailUnread, mainEmailExpanded, expandedUnreadKey, markAsRead, manuallyMarkedUnreadId]);

  // Clear scheduled set and retry counter when changing emails
  useEffect(() => {
    bodyRetryCountRef.current = 0;
    autoReadAttemptsRef.current.clear();
    return () => {
      scheduledAutoReadRef.current.clear();
    };
  }, [selectedEmailId]);

  // Auto-fetch body when viewing an email without body.
  // PRIORITY: fetch the opened email FIRST; only fetch its thread siblings
  // once the opened email's body has arrived (or permanently failed). The
  // effect re-runs when displayEmail.rawBody lands, so gating the sibling
  // loop on that ordering means the message the user is looking at downloads
  // before the rest of the thread — no wasted round-trips racing it.
  useEffect(() => {
    // Fetch when the body is missing OR when an attachment email still lacks
    // parsed attachment metadata (attachmentSizes null → legacy row; the source
    // parse on fetch fills real filenames + sizes so the chip + download work).
    const needsFetch = (e: { rawBody?: string | null; hasAttachments?: boolean; attachmentSizes?: string | null }) =>
      !e.rawBody || (!!e.hasAttachments && !e.attachmentSizes);

    if (displayEmail && needsFetch(displayEmail) && !loadingBodies.has(displayEmail.id) && !failedBodies.has(displayEmail.id)) {
      console.log('[EmailDetail] Auto-fetching body for opened email (priority):', displayEmail.id);
      fetchEmailBody(displayEmail.id);
    }

    // Opened email is "resolved" once it has a body or gave up — only then
    // do we start the (lower-priority) thread-sibling downloads.
    const openedResolved = !displayEmail || !!displayEmail.rawBody || failedBodies.has(displayEmail.id);
    if (!openedResolved) return;

    for (const email of threadEmails) {
      if (email.id === displayEmail?.id) continue; // already handled above
      // In chat view, all emails are visible — fetch all bodies.
      // In accordion view, only fetch expanded emails.
      const wantBody = chatViewEnabled ? true : expandedThreads.has(email.id);
      if (wantBody && needsFetch(email) && !loadingBodies.has(email.id) && !failedBodies.has(email.id)) {
        console.log('[EmailDetail] Auto-fetching body for thread sibling:', email.id);
        fetchEmailBody(email.id);
      }
    }
  }, [displayEmail, threadEmails, expandedThreads, loadingBodies, failedBodies, fetchEmailBody, chatViewEnabled]);

  // Populate the inline-image cache from thread email rawBodies as they
  // land. The cache is in-memory (lost on app restart), but each email's
  // rawBody in DB is durable, so re-populating from rawBody here makes
  // `sarv-image:HASH` refs in cached AI extractions resolve correctly
  // even after restart. Hashes are deterministic (FNV-1a of the data URL).
  useEffect(() => {
    if (!chatViewEnabled) return;
    for (const email of threadEmails) {
      if (email.rawBody) populateCacheFromHtml(email.rawBody);
    }
  }, [threadEmails, chatViewEnabled]);

  // Retry failed body fetches after a delay (transient errors like timeout/disconnection)
  // Max 3 retries to avoid infinite loops
  useEffect(() => {
    if (failedBodies.size === 0 || bodyRetryCountRef.current >= 3) return;

    // Check if any failed emails still have no body in the thread
    const failedInThread = threadEmails.filter(
      e => !e.rawBody && failedBodies.has(e.id)
    );
    if (failedInThread.length === 0) return;

    // Retry after 5 seconds
    if (bodyRetryTimerRef.current) clearTimeout(bodyRetryTimerRef.current);
    bodyRetryTimerRef.current = setTimeout(() => {
      bodyRetryCountRef.current++;
      console.log(`[EmailDetail] Retrying ${failedInThread.length} failed body fetches (attempt ${bodyRetryCountRef.current}/3)`);
      // Clear failed IDs to allow retry
      const store = useEmailStore.getState();
      const newFailed = new Set(store.failedBodies);
      for (const email of failedInThread) {
        newFailed.delete(email.id);
      }
      useEmailStore.setState({ failedBodies: newFailed });
    }, 5000);

    return () => {
      if (bodyRetryTimerRef.current) clearTimeout(bodyRetryTimerRef.current);
    };
  }, [failedBodies, threadEmails]);

  const toggleThread = (threadId: string) => {
    const newExpanded = new Set(expandedThreads);
    if (newExpanded.has(threadId)) {
      newExpanded.delete(threadId);
    } else {
      newExpanded.add(threadId);
    }
    setExpandedThreads(newExpanded);
  };

  const toggleFullContent = (emailId: string) => {
    const newSet = new Set(showFullContent);
    if (newSet.has(emailId)) {
      newSet.delete(emailId);
    } else {
      newSet.add(emailId);
    }
    setShowFullContent(newSet);
  };

  const toggleSignature = (emailId: string) => {
    const newSet = new Set(showSignatures);
    if (newSet.has(emailId)) {
      newSet.delete(emailId);
    } else {
      newSet.add(emailId);
    }
    setShowSignatures(newSet);
  };

  // Track if we've set initial expanded state for this email
  const initialExpandSetRef = useRef<string | null>(null);
  // Baseline of thread email ids per selection, so messages that fold into an
  // ALREADY-OPEN thread (via the "new message" banner's Show) get auto-expanded
  // — the initial auto-expand effect below only runs once per selectedEmailId.
  const threadExpandTrackRef = useRef<{ selectedId: string | null; ids: Set<string> }>({ selectedId: null, ids: new Set() });
  // Pending "mark whole thread read on open" timer (0ms — immediate), kept in a
  // ref so we can cancel it if the user navigates to a different thread before
  // it fires (otherwise it could mark the PREVIOUS thread's emails read).
  // Cancelled on selection change, not on every re-render, so body streaming
  // doesn't starve it.
  const markThreadReadTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Auto-expand logic + mark all thread emails as read on open
  useEffect(() => {
    if (!loadingThread && threadEmails.length > 0 && selectedEmailId && displayEmail) {
      if (initialExpandSetRef.current !== selectedEmailId) {
        initialExpandSetRef.current = selectedEmailId;
        // New thread selected — cancel any still-pending mark-read timer from
        // the thread we just navigated away from.
        if (markThreadReadTimerRef.current) clearTimeout(markThreadReadTimerRef.current);

        const sortedByDate = [...threadEmails].sort((a, b) => a.date - b.date);
        const oldestEmail = sortedByDate[0];
        const latestEmail = sortedByDate[sortedByDate.length - 1];

        // Mark ALL unread emails in the thread as read (Gmail behaviour).
        // Over `allThreadEmails`, NOT the collapsed list: a duplicate folded out
        // of view is still an unread row in the DB, and skipping it would leave
        // the folder's unread badge stuck on mail the user cannot open.
        const allUnread = allThreadEmails.filter(
          (e) => !(e.tags || '').includes('|read|') && manuallyMarkedUnreadId !== e.id
        );
        if (allUnread.length > 0) {
          allUnread.forEach((e) => {
            scheduledAutoReadRef.current.add(e.id);
          });
          const idsToMark = allUnread.map((e) => e.id);
          // Mark read IMMEDIATELY on open (no delay) so fast arrow-scrolling
          // still marks each opened thread read "on the go". markAsRead is the
          // single common path (optimistic local + counters + rollback); the
          // main-process IMAP queue batches/retries the server flag. Kept in a
          // 0ms timer (not synchronous) so the store set() happens off the
          // render pass, and it's still cancel-on-nav-safe via the ref.
          markThreadReadTimerRef.current = setTimeout(async () => {
            const currentState = useEmailStore.getState();
            for (const emailId of idsToMark) {
              if (currentState.manuallyMarkedUnreadId !== emailId) {
                await markAsRead(emailId, true);
              }
              scheduledAutoReadRef.current.delete(emailId);
            }
          }, 0);
        }

        if (threadEmails.length === 1) {
          setMainEmailExpanded(true);
          setExpandedThreads(new Set());
          return;
        }

        const unreadInThread = threadEmails
          .filter((e) => e.id !== oldestEmail.id && !(e.tags || '').includes('|read|'));

        if (unreadInThread.length > 0) {
          const oldestUnread = !(oldestEmail.tags || '').includes('|read|');
          setMainEmailExpanded(oldestUnread);
          setExpandedThreads(new Set(unreadInThread.map((e) => e.id)));
          const scrollTarget = unreadInThread[0].id;
          setTimeout(() => {
            document.getElementById(`thread-${scrollTarget}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
        } else {
          setMainEmailExpanded(false);
          setExpandedThreads(new Set([latestEmail.id]));
          setTimeout(() => {
            document.getElementById(`thread-${latestEmail.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
        }
      }
    }
  }, [loadingThread, threadEmails, allThreadEmails, selectedEmailId, displayEmail, markAsRead, manuallyMarkedUnreadId]);

  // Clear the pending mark-thread-read timer on unmount so it can't fire
  // markAsRead(...) against a torn-down detail pane (e.g. the user closes the
  // pane or switches account within the 1.5s window). Own effect with empty
  // deps so it runs ONLY on unmount — the main effect above intentionally
  // keeps the timer alive across its own re-runs.
  useEffect(() => {
    return () => {
      if (markThreadReadTimerRef.current) clearTimeout(markThreadReadTimerRef.current);
    };
  }, []);

  // Expand messages that fold into an already-open thread (the "new message"
  // banner's Show re-fetches the thread without changing selectedEmailId, so
  // the initial auto-expand effect above never fires for them — they'd land
  // collapsed at the bottom). Gated on the initial pass having claimed this
  // selection so we neither fight it nor treat the first thread population as
  // "new". Body streaming (same ids) is a no-op.
  useEffect(() => {
    if (loadingThread) return;
    if (initialExpandSetRef.current !== selectedEmailId) return;

    const track = threadExpandTrackRef.current;
    const currentIds = threadEmails.map((e) => e.id);

    if (track.selectedId !== selectedEmailId) {
      // First settled view of this thread — record baseline, expand nothing.
      threadExpandTrackRef.current = { selectedId: selectedEmailId, ids: new Set(currentIds) };
      return;
    }

    const newlyAdded = currentIds.filter((id) => !track.ids.has(id));
    if (newlyAdded.length > 0) {
      setExpandedThreads((prev) => {
        const next = new Set(prev);
        newlyAdded.forEach((id) => next.add(id));
        return next;
      });
      // Scroll to the latest folded-in message so the new content is in view.
      const target = newlyAdded[newlyAdded.length - 1];
      setTimeout(() => {
        document.getElementById(`thread-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
    threadExpandTrackRef.current = { selectedId: selectedEmailId, ids: new Set(currentIds) };
  }, [threadEmails, loadingThread, selectedEmailId]);

  // Auto-open inline reply when a saved draft (manual OR AI-generated) exists
  // for any email in the currently-viewed thread. Gmail-style: open thread →
  // see saved draft inline → edit & send, or dismiss.
  const draftOpenedForRef = useRef<string | null>(null);

  // Session-level dismissal set: once the user discards a draft for a thread,
  // don't auto-open any draft for that thread again during this app session —
  // even if the DB still has one (pipeline re-creation, IMAP re-sync lag,
  // stale agent proposal, etc.). Cleared on process restart.
  const dismissedThreadsRef = useRef<Set<string>>(new Set());
  // Threads whose AI-extraction is currently in-flight. Prevents a
  // second runAIExtraction from kicking off when the user closes
  // mid-flight and reopens — the LLM requests from the first call
  // are still in the network panel.
  const extractionInFlightRef = useRef<Set<string>>(new Set());

  const openSavedDraftForThread = async () => {
    if (!latestThreadEmail) return false;
    if (draftOpenedForRef.current === latestThreadEmail.id) return false;
    // Check EVERY thread this view could be showing, not just the newest
    // message's: the newest row can be an optimistic sent row carrying a
    // different (or not-yet-assigned) thread id, and a single-key check silently
    // missed the dismissal handleCloseInlineReply had just recorded.
    //
    // A send inside its undo window is likewise never a reason to open a draft —
    // it is the reason that draft is about to be deleted. The optimistic sent row
    // lands in the thread BEFORE the window elapses and re-runs this effect at
    // exactly the moment the draft still exists, which is what put the composer
    // back under the mail the user had just sent.
    const threadKeys = threadKeysOf([latestThreadEmail, selectedEmail, ...threadEmails]);
    const sendingKeys = pendingSendThreadKeys(useEmailStore.getState().pendingSend);
    if (shouldSuppressDraftAutoOpen(threadKeys, dismissedThreadsRef.current, sendingKeys)) {
      console.log('[Draft] Auto-open suppressed — thread already handled or a send is in flight');
      return false;
    }
    try {
      // Prefer an actual draft row already loaded in this thread. This is the
      // robust path: it covers IMAP-synced drafts (tagged only with their
      // Drafts folder, so findForThread's in_reply_to match would miss them)
      // AND standalone drafts, and it hands us the draft's message-id so
      // editing replaces it in place and discard removes exactly it (Gmail 6→5).
      const threadDrafts = rawThreadEmails
        .filter((e: any) => isDraftEmail(e, draftFolderPaths))
        .sort((a: any, b: any) => (b.date || 0) - (a.date || 0));

      if (threadDrafts.length > 0) {
        const d: any = threadDrafts[0];
        const draftHtml = d.cleanBody
          ? d.cleanBody.split('\n').map((line: string) => `<p>${line || '&nbsp;'}</p>`).join('')
          : (d.rawBody || d.htmlBody || '');
        draftOpenedForRef.current = latestThreadEmail.id;

        // Standalone draft (no surrounding conversation) → open the FULL compose
        // window so the user can edit To/Subject/body (a reply box has no subject
        // field). Reply-drafts within a real thread stay in the inline box below.
        if (threadEmails.length === 0) {
          editDraftInComposer({
            to: d.toAddress || '',
            cc: d.ccAddress || '',
            subject: d.subject || '',
            htmlContent: draftHtml,
            attachments: [],
            draftMessageId: d.messageId,
            threadId: d.threadId,
            accountId: d.accountId ?? useEmailStore.getState().viewAccountId ?? undefined,
          });
          // The draft now lives in the full composer, not the reading pane —
          // drop the selection so closing the composer lands back on the list.
          clearSelectedEmail();
          console.log('[Draft] Opened standalone draft in full composer', d.messageId);
          return true;
        }

        setReplyingToEmail(latestThreadEmail);
        setInlineReplyMode('replyAll');
        setInlineReplyDraft({
          to: d.toAddress || latestThreadEmail.fromAddress || '',
          cc: d.ccAddress || '',
          // Preserve the draft's own subject; when it's blank (older drafts saved
          // with no subject → "(no subject)" in the list AND an empty subject on
          // send), fall back to the conversation's Re: subject.
          subject: replySubjectFor(d.subject, latestThreadEmail.subject),
          htmlContent: draftHtml,
          attachments: [],
          draftMessageId: d.messageId,
        });
        setShowInlineReply(true);
        console.log('[Draft] Opened thread draft inline', d.messageId);
        return true;
      }

      // Collect message-ids of all emails in this thread (drafts are linked
      // via their in_reply_to header pointing at one of these).
      const messageIds = threadEmails
        .map((e: any) => e.messageId)
        .filter(Boolean);
      if (messageIds.length === 0 && latestThreadEmail.messageId) {
        messageIds.push(latestThreadEmail.messageId);
      }
      if (messageIds.length === 0) return false;

      const res = await (window.electronAPI as any).drafts?.findForThread(
        messageIds,
        (latestThreadEmail as any).accountId ?? useEmailStore.getState().viewAccountId ?? undefined,
      );
      if (!res?.success || !res.data) {
        // No manual draft yet — fall back to an AI proposal's draftBody that
        // hasn't been written to IMAP yet (pipeline still processing).
        return await openAIProposalDraft();
      }

      const draft = res.data;
      // Prefer the raw/clean body as HTML for the editor
      const draftHtml = draft.cleanBody
        ? draft.cleanBody
            .split('\n')
            .map((line: string) => `<p>${line || '&nbsp;'}</p>`)
            .join('')
        : (draft.rawBody || '');

      // Detect AI origin by checking agent_decisions (best-effort)
      let isAIDraft = false;
      let aiReasoning = '';
      let agentDecisionId: string | undefined;
      try {
        const proposals = await (window.electronAPI.agent as any).getProposals();
        if (proposals?.success && Array.isArray(proposals.data)) {
          const match = proposals.data.find((d: any) =>
            (d.proposedAction === 'reply' || d.proposedAction === 'reply_all') &&
            threadEmails.some((e: any) => e.id === d.emailId)
          );
          if (match) {
            isAIDraft = true;
            aiReasoning = match.draftReasoning || match.reasoning || '';
            agentDecisionId = match.id;
          }
        }
      } catch {}

      draftOpenedForRef.current = latestThreadEmail.id;
      setReplyingToEmail(latestThreadEmail);
      setInlineReplyMode('replyAll');
      setInlineReplyDraft({
        to: latestThreadEmail.fromAddress || draft.toAddress || '',
        cc: draft.ccAddress || '',
        subject: replySubjectFor(draft.subject, latestThreadEmail.subject),
        htmlContent: draftHtml,
        attachments: [],
        draftMessageId: draft.messageId,
        isAIDraft,
        aiReasoning,
        agentDecisionId,
      } as any);
      setShowInlineReply(true);
      console.log('[Draft] Opened saved draft inline for thread', latestThreadEmail.id, { isAIDraft });
      return true;
    } catch (e) {
      console.error('[Draft] Failed to open saved draft:', e);
      return false;
    }
  };

  // Fallback: when an AI proposal exists with a draftBody but it hasn't
  // made it to the IMAP Drafts folder yet (or sync hasn't pulled it back).
  const openAIProposalDraft = async (): Promise<boolean> => {
    if (!latestThreadEmail) return false;
    // Same suppression as openSavedDraftForThread — an AI proposal is still a
    // draft, and re-opening one for a thread the user just sent or dismissed is
    // the same bug wearing a different hat.
    const threadKeys = threadKeysOf([latestThreadEmail, selectedEmail, ...threadEmails]);
    const sendingKeys = pendingSendThreadKeys(useEmailStore.getState().pendingSend);
    if (shouldSuppressDraftAutoOpen(threadKeys, dismissedThreadsRef.current, sendingKeys)) return false;
    try {
      const res = await (window.electronAPI.agent as any).getProposals();
      if (!res?.success || !Array.isArray(res.data)) return false;
      const match = res.data.find((d: any) =>
        d.emailId === latestThreadEmail.id &&
        (d.proposedAction === 'reply' || d.proposedAction === 'reply_all') &&
        !!d.draftBody
      );
      if (!match) {
        console.log('[Draft] No saved draft or AI proposal for thread', latestThreadEmail.id);
        return false;
      }

      const draftHtml = String(match.draftBody || '')
        .split('\n')
        .map((line: string) => `<p>${line || '&nbsp;'}</p>`)
        .join('');

      draftOpenedForRef.current = latestThreadEmail.id;
      setReplyingToEmail(latestThreadEmail);
      setInlineReplyMode('replyAll');
      setInlineReplyDraft({
        to: latestThreadEmail.fromAddress || '',
        cc: '',
        htmlContent: draftHtml,
        attachments: [],
        isAIDraft: true,
        aiReasoning: match.draftReasoning || match.reasoning || '',
        agentDecisionId: match.id,
      } as any);
      setShowInlineReply(true);
      console.log('[Draft] Opened AI proposal draft inline for', latestThreadEmail.id);
      return true;
    } catch (e) {
      console.error('[Draft] AI proposal fallback failed:', e);
      return false;
    }
  };

  const openDraftRef = useRef(openSavedDraftForThread);
  openDraftRef.current = openSavedDraftForThread;

  useEffect(() => {
    if (loadingThread) return;
    if (!latestThreadEmail) return;
    if (showInlineReply) return; // user or another flow already opened one
    openDraftRef.current();
  }, [loadingThread, latestThreadEmail?.id, threadEmails.length, showInlineReply]);

  // Listen for drafts that land AFTER the user has already opened the email.
  useEffect(() => {
    const api = (window.electronAPI.agent as any);
    if (!api?.onDraftReady) return;
    const cleanup = api.onDraftReady((data: { emailId: string }) => {
      if (!latestThreadEmail) return;
      const isInThread = threadEmails.some((e: any) => e.id === data.emailId) || data.emailId === latestThreadEmail.id;
      if (!isInThread) return;
      if (showInlineReply) return;
      openDraftRef.current();
    });
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [latestThreadEmail?.id, threadEmails.length, showInlineReply]);

  // Reset states when switching emails
  useEffect(() => {
    if (selectedEmailId && initialExpandSetRef.current !== selectedEmailId) {
      setShowFullHeaders(false);
      setShowFullContent(new Set());
      setShowInlineReply(false);
      setReplyingToEmail(null);
      setShowInlineForward(false);
      setForwardingEmail(null);
      draftOpenedForRef.current = null;
      setConversationMessages(null);
      setConversationError(null);
      // Pre-set conversationLoading=true when chat view will auto-show.
      // Otherwise the first render lands in ChatView with mode='ai',
      // conversationMessages=null, conversationLoading=false → which
      // displays "No AI Conversation Found" until the auto-trigger
      // effect fires and flips loading on. That brief flash is the
      // "Standard view appears then snaps to chat" flicker.
      const autoOn = isAutoChatViewEnabled() && isConversationModeEnabled() && !!getDefaultProvider();
      setConversationLoading(autoOn);
      setConversationUpdating(false);
      setConversationPartial(false);
      setConversationProgress(null);
      // Reset auto-enable ref so extraction re-fires for the new email
      autoEnabledRef.current = null;
      // Keep chat view on if auto setting is enabled, otherwise reset. Always
      // start on Standard (deterministic); the user opts into AI View.
      setChatViewEnabled(autoOn);
      setChatManuallyEnabled(false); // fresh email — no explicit chat choice yet
      setShowAIView(false);
    }
  }, [selectedEmailId]);

  // Detect "loop me in" / forwarded-without-comment emails: a SINGLE email
  // whose body contains a quoted/forwarded conversation. Without this, the
  // multi-email gate below (`threadEmails.length > 1`) misses these and the
  // user is stuck in Standard view with the entire history dumped inline.
  const hasInlineConversation = useMemo(() => {
    if (threadEmails.length !== 1) return false;
    const e = threadEmails[0];
    // STRICT detection: a single email opens as chat ONLY when it embeds a
    // genuine multi-message thread (looped-in forward / ongoing chain), not
    // for a plain reply or a transactional email that merely contains a
    // quote marker. See hasEmbeddedConversation.
    return hasEmbeddedConversation(e?.rawBody || e?.cleanBody);
  }, [threadEmails]);

  // Derived: should the rendering tree show Chat View layout?
  // (EmailCard hides, ThreadChatView renders.) Used by EmailDetail.tsx
  // and EmailCard.tsx so the loop-me-in case lights up correctly.
  //
  // While the thread is still loading we don't yet have threadEmails, so
  // we pre-show chat view ONLY when the selected email's thread genuinely
  // has multiple messages (threadMessageCount from the list subquery).
  // A bare `|| loadingThread` here opened chat view for EVERY email during
  // load — including single transactional mail (boarding passes, OTPs) —
  // because auto-chat-view is on by default. Single-message threads now
  // stay in the standard card unless their body turns out to embed a
  // quoted conversation (hasInlineConversation, evaluated once loaded).
  const selectedThreadCount = selectedEmail?.threadMessageCount ?? threadEmails.length;
  // A single email that is a DESIGNED/transactional HTML message (marketing/alert
  // built from layout tables + inline styles) shouldn't auto-open chat — its
  // bespoke layout doesn't belong in a conversation bubble. It defaults to
  // Standard and only shows chat if the user explicitly toggles it. Human
  // "loop-me-in" text forwards (no such markup) still auto-open chat.
  const isDesignedHtmlEmail = (html?: string | null): boolean => {
    if (!html) return false;
    return /<style[\s>]/i.test(html) ||
      /role=["']presentation["']/i.test(html) ||
      /\bbgcolor=/i.test(html) ||
      (html.match(/<table/gi)?.length ?? 0) >= 2;
  };
  const singleDesignedEmail =
    threadEmails.length === 1 &&
    isDesignedHtmlEmail(threadEmails[0]?.rawBody || threadEmails[0]?.cleanBody);
  const chatViewActive = chatViewEnabled && (
    threadEmails.length > 1 ||
    (hasInlineConversation && !(singleDesignedEmail && !chatManuallyEnabled)) ||
    (loadingThread && selectedThreadCount > 1)
  );

  // Content-compare two bubble lists so redundant snapshots (re-fired
  // effects re-reading the cache, duplicate progress updates) don't
  // re-render the chat view. Body strings compare with cheap reference/
  // length-first equality semantics of `!==`, so this is O(n) for the
  // common no-change case.
  const messagesEqual = (a: ConversationMessage[] | null, b: ConversationMessage[]): boolean => {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      if (x.id !== y.id || x.date !== y.date || x.body !== y.body || x.isExtracted !== y.isExtracted) return false;
    }
    return true;
  };
  // Only call setConversationMessages with NEW content — returning the
  // previous array reference lets React bail out of the re-render when
  // nothing changed (T1: cached bubbles must not re-render as bodies
  // stream in and the auto-extract effect re-fires).
  const applyMessagesIfChanged = (next: ConversationMessage[]) => {
    setConversationMessages(prev => (prev && messagesEqual(prev, next) ? prev : next));
  };
  // T3 — progressive extraction: bubbles render as each email's
  // extraction completes; done/total/status feed conversationProgress.
  const handleExtractionProgress = (update: ConversationProgress) => {
    if (update.messages.length > 0) {
      applyMessagesIfChanged(update.messages);
      // Bubbles are on screen — drop the full-pane spinner even though
      // the run is still going; conversationProgress carries the rest.
      setConversationLoading(false);
    }
    setConversationProgress({ done: update.done, total: update.total, status: update.status });
  };

  // AI extraction — cache-first to eliminate "Extracting..." flash.
  // T1: the conversation-cache read happens BEFORE the bodies-loaded
  // gate, so a previously-extracted thread renders instantly on open
  // (warm open) while bodies keep downloading in the background for
  // attachments/actions — cached bubbles don't need them. Only the
  // extraction of UNCACHED emails still waits for bodies.
  const runAIExtraction = async (forceRefresh = false) => {
    if (!displayEmail?.threadId || !getDefaultProvider() || !isConversationModeEnabled()) return;

    // Guard against duplicate concurrent extractions for the same
    // thread. The pattern that hit the user: click re-extract → some
    // LLM calls still in flight → close thread → re-open → autoExtract
    // effect fires runAIExtraction again → a second round of LLM calls
    // piles on top of the still-pending first round. Network panel
    // fills with duplicate /completions requests. The guard sits ahead
    // of the cache read too, so a re-fired effect can't overwrite a
    // progressive run's bubbles with a stale cache snapshot.
    //
    // Defensive: optional-chain the ref so HMR partial reloads (where
    // the closure executes against a stale scope) don't ReferenceError.
    const threadId = displayEmail.threadId;
    const inFlight = extractionInFlightRef?.current;
    if (inFlight?.has(threadId)) {
      console.log('[Conversation] Extraction already in flight for', threadId, '— skipping');
      return;
    }
    inFlight?.add(threadId);
    try {
      const bodyReady = (e: { rawBody?: string | null; cleanBody?: string | null }) =>
        (!!e.rawBody && e.rawBody.trim().length > 0) ||
        (!!e.cleanBody && e.cleanBody.trim().length > 0);

      // Signal loading immediately so UI shows spinner (not "No AI Conversation Found")
      if (!conversationMessages) {
        setConversationLoading(true);
      }

      // Cache-first: check if a previous run / background scheduler
      // already extracted this thread. The raw row is kept around and
      // handed to extractConversation as the T2 cachedHint so the
      // service never repeats this IPC read.
      let cachedRow: any | null = null;
      if (!forceRefresh) {
        try {
          const cacheResult = await window.electronAPI.ai.getConversation(threadId);
          if (cacheResult.success && cacheResult.data) cachedRow = cacheResult.data;
        } catch {
          // Cache check failed, proceed with extraction
        }
      }

      // Decide whether the row is instantly renderable. Honor
      // EXTRACTION_VERSION here too — extractConversation also does
      // this check, but we'd render the cached bubbles BEFORE calling
      // it. Without the version gate here, a cache built with stale
      // extraction logic (e.g. pre-LLM-double-escape fix) would render
      // forever until the user manually clicks refresh. The stale row
      // still goes into cachedHint below — the service replays the
      // same decision and runs the full re-extract.
      let renderable: { messages: ConversationMessage[]; processedIds: string[]; wasPartial: boolean } | null = null;
      if (cachedRow) {
        const cachedVersion = cachedRow.modelUsed?.includes('|v')
          ? parseInt(cachedRow.modelUsed.split('|v')[1])
          : 0;
        if (cachedVersion < EXTRACTION_VERSION) {
          console.log(
            `[Conversation] Renderer cache shortcut: stale version ${cachedVersion} < ${EXTRACTION_VERSION} — falling through to extractConversation for re-extract`,
          );
        } else {
          try {
            const messages = JSON.parse(cachedRow.messages || '[]');
            const processedIds = JSON.parse(cachedRow.processedEmailIds || '[]');
            if (Array.isArray(messages) && messages.length > 0 && Array.isArray(processedIds) && processedIds.length > 0) {
              renderable = {
                messages,
                processedIds,
                wasPartial: (cachedRow.modelUsed || '').includes('|partial'),
              };
            }
          } catch {
            // Malformed cache row — treat as miss, full extraction below.
          }
        }
      }

      if (renderable) {
        // Warm open: cached bubbles render NOW — no waiting on body
        // downloads or LLM calls.
        applyMessagesIfChanged(renderable.messages);
        setConversationPartial(renderable.wasPartial);
        setConversationLoading(false);

        const { processedIds } = renderable;
        const currentEmailIds = threadEmails.map(e => e.id);
        const newEmailIds = currentEmailIds.filter(id => !processedIds.includes(id));

        if (newEmailIds.length === 0) {
          // STRICT mode: cache hit just shows the cached bubbles.
          // No auto-retry — even if the cache was marked partial
          // last time, retrying on every open would burn LLM calls
          // on the same emails that already failed. The amber
          // refresh icon (driven by setConversationPartial above)
          // tells the user something is missing; they click it to
          // explicitly retry. We no longer test for "missing"
          // sourceEmailIds because in strict mode an email with
          // failed LLM extraction LEGITIMATELY has no bubble.
          console.log(
            renderable.wasPartial
              ? '[Conversation] Cache hit (partial — click refresh to retry failed emails)'
              : '[Conversation] Cache hit — loading instantly'
          );
          return;
        }

        // Cache exists but has unprocessed emails — cached bubbles are
        // already on screen; only the NEW emails' extraction waits for
        // their bodies (cached emails' bodies are irrelevant here).
        const newEmails = threadEmails.filter(e => newEmailIds.includes(e.id));
        if (!newEmails.every(bodyReady)) {
          const loaded = newEmails.filter(bodyReady).length;
          console.log(
            `[Conversation] Cached bubbles shown — waiting for ${newEmails.length - loaded}/${newEmails.length} new-email bodies before incremental extraction`,
          );
          // The auto-extract effect re-fires when bodiesLoadedCount
          // changes and we come back through here.
          return;
        }

        console.log('[Conversation] Cache partial hit — showing cached, processing new emails');
        // Run incremental update with bottom loader instead of full loading state
        setConversationUpdating(true);
        setConversationError(null);
        try {
          const result = await extractConversation(
            threadId,
            threadEmails,
            displayEmail.toAddress || '',
            { cachedHint: { row: cachedRow }, onProgress: handleExtractionProgress },
          );
          applyMessagesIfChanged(result.messages);
          setConversationPartial(result.partial);
        } catch (err) {
          console.error('[Conversation] Incremental extraction failed:', err);
        } finally {
          setConversationUpdating(false);
          setConversationProgress(null);
        }
        return;
      }

      // Cache miss / stale / unusable → full extraction. Guard: don't
      // fire before every email body has been downloaded over IMAP.
      // Bodies arrive asynchronously after a thread opens; if
      // extraction beats the body fetch, every email's rawBody is
      // empty and the entire conversation caches as "no new content"
      // bubbles (the cache then claims those emails are "processed" so
      // we're stuck with 17× empty forever). The body-fetch effect
      // drives a re-render when bodies land, and the auto-extract
      // effect (deps include the bodies-loaded count) re-fires then.
      // Guard: don't fire before ANY email body is available. Bodies arrive
      // asynchronously; if extraction beats every body fetch, all rawBodies
      // are empty and the whole thread caches as "no new content" bubbles.
      //
      // We previously waited for EVERY body (`threadEmails.every`), but a
      // single permanently-unfetchable body (it lands in failedBodies and
      // never becomes ready) then wedged the chat view on a spinner forever
      // and made the refresh button a no-op. Instead only wait while ZERO
      // bodies are ready; once at least one is in hand we proceed and let
      // extractConversation's own `bodiedEmails` filter extract the available
      // subset and skip the missing ones (picked up on a later pass if their
      // body ever lands). forceRefresh bypasses the wait entirely.
      const readyCount = threadEmails.filter(bodyReady).length;
      if (!forceRefresh && readyCount === 0) {
        console.log(
          `[Conversation] Skipping extraction — 0/${threadEmails.length} bodies loaded, waiting for at least one`,
        );
        if (!conversationMessages) setConversationLoading(true);
        return;
      }

      setConversationLoading(true);
      setConversationError(null);
      // Distinguish "failed entirely" (no bubbles ever produced → show
      // the error fallback) from "failed after progressive bubbles
      // rendered" (keep what's on screen, mark partial).
      let progressed = false;
      try {
        // Don't pre-clear the cache on forceRefresh. The previous version
        // wrote an empty row to the DB before starting LLM calls — and if
        // the user closed the thread mid-extraction, reopening saw the
        // empty cache and triggered a SECOND full extraction. Now we let
        // the new result overwrite the cache atomically when
        // extractConversation finishes; if the user closes mid-flight,
        // the old cache stays as-is and a re-open hits cache (no new
        // LLM calls).
        const result = await extractConversation(
          threadId,
          threadEmails,
          displayEmail.toAddress || '',
          {
            forceRefresh,
            // Hand over the (possibly null / stale / unusable) row we
            // already read so the service skips its duplicate IPC read
            // and replays its own decisions on identical data. On
            // forceRefresh nothing was read — the service skips its
            // cache check anyway.
            ...(forceRefresh ? {} : { cachedHint: { row: cachedRow } }),
            onProgress: (update: ConversationProgress) => {
              if (update.messages.length > 0) progressed = true;
              handleExtractionProgress(update);
            },
          },
        );
        applyMessagesIfChanged(result.messages);
        setConversationPartial(result.partial);
      } catch (err) {
        console.error('[Conversation] Extraction failed:', err);
        if (progressed) {
          // Some bubbles already rendered progressively — keep them and
          // surface the amber partial affordance instead of wiping the
          // pane with an error.
          setConversationPartial(true);
        } else {
          setConversationError('Failed to extract conversation');
          setConversationMessages(null);
        }
      } finally {
        setConversationLoading(false);
        setConversationProgress(null);
      }
    } finally {
      inFlight?.delete(threadId);
    }
  };

  const handleRetryConversation = () => {
    // Drop the entire chat bubble list immediately so the user gets
    // visual confirmation the refresh is happening — otherwise old
    // (potentially stale) bubbles linger for the whole LLM round-trip
    // and it looks like the click did nothing. (The DB cache row is
    // NOT pre-cleared — the fresh result overwrites it atomically when
    // extraction finishes; progressive bubbles repopulate the pane as
    // they complete.)
    setConversationMessages(null);
    setConversationPartial(false);
    setConversationError(null);
    runAIExtraction(true);
  };

  // Auto-enable chat view and/or pre-run extraction when:
  //   • thread has multiple emails, OR
  //   • a single email contains an embedded conversation
  //     (forwarded chain / "loop me in" reply with full history quoted).
  //
  // The single-email branch is gated on body availability — the body is
  // fetched asynchronously after the email opens, so we only know whether
  // it has quoted history once `threadEmails[0].rawBody` lands. The effect
  // re-fires on body change because `hasInlineConversation` is in the dep
  // array via the useMemo it derives from.
  const autoEnabledRef = useRef<string | null>(null);
  // Count of thread emails whose bodies have been downloaded. Driving
  // the auto-extract effect off this (not just threadEmails.length)
  // makes the effect re-fire as bodies stream in over IMAP, so the
  // deferred extraction kicks off the moment the last body lands.
  const bodiesLoadedCount = threadEmails.filter(
    e => (!!e.rawBody && e.rawBody.trim().length > 0) ||
         (!!e.cleanBody && e.cleanBody.trim().length > 0),
  ).length;
  useEffect(() => {
    if (loadingThread) return;
    if (!displayEmail?.threadId) return;
    if (!isConversationModeEnabled() || !getDefaultProvider()) return;
    // Don't gate on autoEnabledRef yet — we may need to re-fire if a
    // previous attempt deferred itself waiting for bodies. Only mark
    // the thread auto-enabled AFTER bodies are ready (below).
    const alreadyEnabledForReadyThread =
      autoEnabledRef.current === displayEmail.threadId &&
      bodiesLoadedCount === threadEmails.length;
    if (alreadyEnabledForReadyThread) return;

    const shouldExtract = threadEmails.length > 1 || hasInlineConversation;
    if (!shouldExtract) return;

    // Only mark this thread "auto-enabled" once every body is in
    // hand — otherwise the deferred extraction has no chance to
    // re-run when the last body lands.
    if (bodiesLoadedCount === threadEmails.length) {
      autoEnabledRef.current = displayEmail.threadId;
    }

    // Always pre-run extraction in background so chat view loads instantly.
    // Don't gate on conversationMessages — the reset effect's setState hasn't
    // flushed yet in this render cycle, so the closure sees stale values.
    // runAIExtraction has its own bodies-ready precondition; if bodies
    // are still loading it'll log and bail (we'll come back on the
    // next render).
    runAIExtraction();

    // Only auto-switch UI to chat mode if auto-chat-view is on — but open the
    // Standard view; AI is pre-extracted in the background and shown only when
    // the user switches to AI View.
    if (isAutoChatViewEnabled()) {
      setChatViewEnabled(true);
      setShowAIView(false);
    }
  }, [loadingThread, threadEmails.length, bodiesLoadedCount, hasInlineConversation, displayEmail?.threadId]);

  // Auto-detect new emails in thread and trigger AI extraction for them.
  // Strict mode: NO optimistic DOM-cleaned push. The bubble for the new
  // email only appears once the LLM returns; until then the chat view
  // shows the existing extracted bubbles plus a "Processing new
  // messages…" footer (driven by setConversationUpdating).
  const prevThreadCountRef = useRef(0);
  useEffect(() => {
    if (
      chatViewEnabled &&
      conversationMessages &&
      !conversationLoading &&
      threadEmails.length > prevThreadCountRef.current &&
      prevThreadCountRef.current > 0 &&
      displayEmail?.threadId
    ) {
      console.log(`[Conversation] New emails detected in thread (${prevThreadCountRef.current} → ${threadEmails.length}), running AI extraction...`);
      const threadId = displayEmail.threadId;
      const userEmail = displayEmail.toAddress || '';
      (async () => {
        setConversationUpdating(true);
        try {
          const result = await extractConversation(threadId, threadEmails, userEmail, {
            onProgress: handleExtractionProgress,
          });
          applyMessagesIfChanged(result.messages);
          setConversationPartial(result.partial);
          console.log('[Conversation] AI re-extraction for new emails completed');
        } catch (err) {
          console.error('[Conversation] AI re-extraction failed:', err);
        } finally {
          setConversationUpdating(false);
          setConversationProgress(null);
        }
      })();
    } else if (
      chatViewEnabled &&
      conversationMessages &&
      threadEmails.length < prevThreadCountRef.current
    ) {
      // A message left the thread (delete/archive/spam). The re-extract path
      // above only handles ADDITIONS, so prune orphaned bubbles here — otherwise
      // the removed email's bubble lingers as a ghost (with a broken source).
      // Bubbles whose source email is still present (incl. embedded quotes) stay.
      const liveIds = new Set(threadEmails.map(e => e.id));
      const pruned = conversationMessages.filter(m => liveIds.has(m.sourceEmailId));
      if (pruned.length !== conversationMessages.length) applyMessagesIfChanged(pruned);
    }
    prevThreadCountRef.current = threadEmails.length;
  }, [threadEmails.length, chatViewEnabled, conversationMessages, conversationLoading]);

  const handleReExtractMessage = async (messageId: string) => {
    if (!conversationMessages || !displayEmail?.threadId) return;
    const msg = conversationMessages.find(m => m.id === messageId);
    if (!msg) return;
    const sourceEmail = threadEmails.find(e => e.id === msg.sourceEmailId);
    if (!sourceEmail) return;

    // Decide which extraction path to use based on the SOURCE EMAIL'S
    // structure, not on the current bubble count:
    //
    //   • Source has quoted history (any "On X wrote:", From:/Sent:,
    //     forward/original banner, blockquote)  → Phase 1 SPLIT.
    //     Re-runs the multi-message extraction. Even if the chat view
    //     currently only has 1 bubble for this source, we want to try
    //     again to recover the embedded messages.
    //
    //   • Source is a clean reply with no quoted history → Phase 2
    //     CLEANUP. Just strip signature/footer and refresh the bubble.
    //
    // Counting sibling bubbles is unreliable because it depends on
    // whether Phase 1 succeeded LAST time, not on whether it SHOULD
    // succeed. The actual source structure is the right signal.
    const sourceHasQuotedHistory = hasQuotedHistory(
      sourceEmail.rawBody || sourceEmail.cleanBody,
    );

    // Optimistic clear FIRST so the user sees immediate feedback that
    // their click did something. Bubbles tied to this source vanish;
    // remaining bubbles (from other emails in the thread) stay put.
    // For Phase 2 (single-bubble cleanup) we blank the body so the
    // bubble shows the "Loading content…" spinner from ChatView while
    // the LLM runs.
    const sourceMsgIds = new Set(
      conversationMessages
        .filter(m => m.sourceEmailId === msg.sourceEmailId)
        .map(m => m.id),
    );
    // Optimistic state: KEEP every bubble visible, just blank the
    // bodies of any bubble tied to this source and set
    // isExtracted=false so ChatView renders the "Loading content…"
    // spinner in place. Previously the Phase 1 path FILTERED bubbles
    // out, so the user saw the row disappear entirely until the LLM
    // returned 2-30 seconds later — looked like the click did
    // nothing.
    //
    // For Phase 1 (multi-bubble split), the count of returned bubbles
    // may differ from the count we blanked. The reconciliation after
    // the LLM completes replaces these placeholders with the new
    // split — extras get dropped, new ones get appended.
    const optimistic: ConversationMessage[] = conversationMessages.map(m =>
      sourceMsgIds.has(m.id) ? { ...m, body: '', isExtracted: false } : m,
    );
    setConversationMessages(optimistic);

    let updated: ConversationMessage[];
    // True when the Phase 1 response had to be salvaged from a truncated
    // LLM output — propagated into the cache's partial flag below.
    let reExtractTruncated = false;

    if (sourceHasQuotedHistory) {
      const siblingCount = sourceMsgIds.size;
      console.log(`[Conversation] Re-extract: source has quoted history — Phase 1 split (currently ${siblingCount} bubble(s) depend on this source)`);
      const splitResult = await aiSplitFirstEmail(
        sourceEmail,
        undefined,
        // Roster lets the splitter resolve attribution lines whose
        // address got mangled (name → thread sender's address).
        threadEmails.map(e => ({ address: e.fromAddress, name: e.fromName })),
      );
      const splitMessages = splitResult?.messages ?? [];
      reExtractTruncated = splitResult?.truncated ?? false;
      if (splitMessages.length === 0) {
        console.warn('[Conversation] Re-extract: Phase 1 split returned no messages — restoring previous bubbles');
        // Restore: we already optimistically cleared, so put the
        // pre-click state back so the user doesn't lose content.
        setConversationMessages(conversationMessages);
        return;
      }
      // Drop the placeholder bubbles we just blanked (they belong to
      // this source) and append the freshly-split bubbles in their
      // place. Bubbles tied to OTHER source emails stay where they
      // are.
      const keptOthers = optimistic.filter(m => !sourceMsgIds.has(m.id));
      // Cross-source dedup: if two emails in the thread both quote
      // the same older message, Phase 1 on each produces a bubble
      // for that older message — and we get duplicates. Skip a new
      // bubble if an existing kept bubble already covers it by
      // (from, date) within 60 seconds.
      //
      // X5: synthetic (dateApprox) dates are sorting-only. They are
      // excluded on BOTH sides here — a kept bubble with a synthetic
      // date never absorbs a new one, and a new part with a synthetic
      // date is always kept (same rule as date-unknown).
      const existingKeys = new Set(
        keptOthers
          .filter(m => m.date !== 0 && !m.dateApprox)
          .map(m => `${m.fromAddress.toLowerCase()}|${m.date}`),
      );
      // Also dedupe near-date matches (split-extracted dates often
      // round to the minute while real-email dates are second-precise).
      const existingNearDate = keptOthers
        .filter(m => m.date !== 0 && !m.dateApprox)
        .map(m => ({ from: m.fromAddress.toLowerCase(), date: m.date }));
      // Pass A — dedup + bind each part to a real thread email by
      // (sender, near-date). Attribution dates lack timezone → wide
      // extracted-vs-real tolerance, matching processThread. Unknown
      // (0) and synthetic dates bind to nothing.
      const candidates: { s: (typeof splitMessages)[number]; matched?: (typeof threadEmails)[number] }[] = [];
      for (const s of splitMessages) {
        const fromLc = (s.fromAddress || '').toLowerCase();
        const reliableDate = s.date !== 0 && !s.dateApprox;
        if (reliableDate) {
          const exactKey = `${fromLc}|${s.date}`;
          const nearMatch = existingNearDate.some(
            e => e.from === fromLc && Math.abs(e.date - s.date) < 60,
          );
          if (existingKeys.has(exactKey) || nearMatch) continue;
        }
        const matched = !reliableDate ? undefined : threadEmails.find(e =>
          e.fromAddress.toLowerCase() === fromLc &&
          Math.abs(e.date - s.date) < EXTRACTED_MATCH_TOLERANCE_S
        );
        candidates.push({ s, matched });
        if (reliableDate) {
          existingKeys.add(`${fromLc}|${s.date}`);
          existingNearDate.push({ from: fromLc, date: s.date });
        }
      }
      // Pass B — X6: when several parts bind to the SAME real email,
      // only the newest part (last in oldest-first order) keeps the
      // real id; history parts get 'extracted-' ids. Duplicate ids
      // broke React keys and this handler's own by-id lookup.
      const lastPartForEmail = new Map<string, number>();
      candidates.forEach((c, i) => {
        if (c.matched) lastPartForEmail.set(c.matched.id, i);
      });
      let extractedIdx = 0;
      const newGroup: ConversationMessage[] = [];
      candidates.forEach((c, i) => {
        const ownsRealId = !!c.matched && lastPartForEmail.get(c.matched.id) === i;
        newGroup.push({
          id: ownsRealId ? c.matched!.id : `extracted-${Date.now()}-${extractedIdx++}`,
          fromAddress: c.s.fromAddress,
          fromName: c.s.fromName,
          toAddress: c.s.toAddress || c.matched?.toAddress || '',
          date: ownsRealId ? c.matched!.date : (c.s.date || 0),
          ...(c.s.dateApprox && !ownsRealId ? { dateApprox: true } : {}),
          body: c.s.body,
          isExtracted: true,
          sourceEmailId: c.matched?.id || sourceEmail.id,
        });
      });
      updated = [...keptOthers, ...newGroup].sort((a, b) => a.date - b.date);
    } else {
      // No quoted history — just strip signature/footer via Phase 2.
      console.log(`[Conversation] Re-extract: no quoted history in source — Phase 2 cleanup`);
      const { body: newBody, failed } = await reExtractSingleMessage(messageId, sourceEmail);
      // Update from the optimistic state (body was blanked); now fill
      // in the cleaned body and flip isExtracted=true. Clear the failed
      // flag on success (or keep it set if the retry failed again) so the
      // per-message error affordance reflects the latest attempt.
      updated = optimistic.map(m =>
        m.id === messageId ? { ...m, body: newBody, isExtracted: true, extractionFailed: failed } : m
      );
    }

    setConversationMessages(updated);

    // Update cache via saveConversationCache so the EXTRACTION_VERSION
    // marker (`|v${N}`) gets written. A previous bug bypassed this and
    // wrote raw `provider.name` — leaving cachedVersion=0 in the DB,
    // which the cache check later treated as stale (0 < EXTRACTION_VERSION),
    // triggering a full re-extraction on every subsequent thread open.
    const provider = getDefaultProvider();
    if (provider) {
      try {
        // Preserve the previously cached processedEmailIds + partial flag.
        // Writing `threadEmails.map(e => e.id)` + partial=false here marked
        // emails as processed that were never extracted (bodies missing,
        // earlier failures) — killing the amber retry affordance and
        // blocking incremental extraction forever. Only this re-extracted
        // source email is newly guaranteed processed.
        let processedIds: string[] = [];
        let wasPartial = conversationPartial;
        try {
          const cacheResult = await window.electronAPI.ai.getConversation(displayEmail.threadId);
          if (cacheResult.success && cacheResult.data) {
            const parsed = JSON.parse(cacheResult.data.processedEmailIds || '[]');
            if (Array.isArray(parsed)) processedIds = parsed;
            wasPartial = cacheResult.data.modelUsed?.includes('|partial') || false;
          }
        } catch { /* no readable cache — fall back to state + source id */ }
        if (!processedIds.includes(sourceEmail.id)) processedIds.push(sourceEmail.id);
        await saveConversationCache(
          displayEmail.threadId,
          updated,
          processedIds,
          provider.name,
          wasPartial || reExtractTruncated,
        );
      } catch (err) {
        console.error('[Conversation] Failed to update cache after re-extract:', err);
      }
    }
  };

  const handleChatViewToggle = (enabled: boolean) => {
    setChatViewEnabled(enabled);
    setChatManuallyEnabled(enabled); // an explicit choice — overrides the designed-email Standard default
    if (enabled) {
      // Open Standard first; pre-extract AI in the background so switching to
      // AI View is instant, but don't force the AI view on.
      setShowAIView(false);
      if (!conversationMessages && !conversationLoading && isConversationModeEnabled() && getDefaultProvider() && displayEmail?.threadId) {
        runAIExtraction();
      }
    } else {
      setConversationError(null);
    }
  };

  // --- Navigation: build thread list from current view's emails ---
  const getNavigationThreads = useEmailStore(state => state.getNavigationThreads);
  const getNavigationTotalCount = useEmailStore(state => state.getNavigationTotalCount);

  const navigationThreads = useMemo(() => {
    return getNavigationThreads();
  }, [getNavigationThreads, emails, searchResults, searchQuery]);

  const currentThreadIndex = useMemo(() => {
    if (!selectedEmailId) return -1;
    return navigationThreads.findIndex(t =>
      t.threadId === selectedEmailId || t.emails.some(e => e.id === selectedEmailId)
    );
  }, [navigationThreads, selectedEmailId]);

  const hasNextEmail = currentThreadIndex >= 0 && currentThreadIndex < navigationThreads.length - 1;
  const hasPreviousEmail = currentThreadIndex > 0;

  const handleNextEmail = () => {
    if (!hasNextEmail) return;
    const nextThread = navigationThreads[currentThreadIndex + 1];
    const emailToSelect = nextThread.firstUnreadEmail || nextThread.latestEmail;
    selectEmail(emailToSelect.id);
  };

  const handlePreviousEmail = () => {
    if (!hasPreviousEmail) return;
    const prevThread = navigationThreads[currentThreadIndex - 1];
    const emailToSelect = prevThread.firstUnreadEmail || prevThread.latestEmail;
    selectEmail(emailToSelect.id);
  };

  // Listen for keyboard shortcut inline reply events (must be before early return)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.mode) {
        inlineReplyHandlerRef.current(detail.mode);
      }
    };
    document.addEventListener('sarvinbox:inline-reply', handler);
    return () => document.removeEventListener('sarvinbox:inline-reply', handler);
  }, []);

  // Listen for keyboard shortcut inline forward events
  useEffect(() => {
    const handler = () => {
      inlineForwardHandlerRef.current();
    };
    document.addEventListener('sarvinbox:inline-forward', handler);
    return () => document.removeEventListener('sarvinbox:inline-forward', handler);
  }, []);

  // Restore draft when undo send triggers
  useEffect(() => {
    if (!restoreDraft || restoreDraft.isInline === false) return;

    if (restoreDraft.mode === 'reply' || restoreDraft.mode === 'replyAll') {
      // Re-open inline reply with the saved draft
      setReplyingToEmail(restoreDraft.replyToEmail);
      setInlineReplyMode(restoreDraft.mode);
      setInlineReplyDraft({
        to: restoreDraft.to,
        cc: restoreDraft.cc,
        htmlContent: restoreDraft.htmlContent,
        attachments: restoreDraft.attachments,
      });
      setShowInlineReply(true);
      setShowInlineForward(false);
      setForwardingEmail(null);
    } else if (restoreDraft.mode === 'forward') {
      // Re-open inline forward with the saved draft
      setForwardingEmail(restoreDraft.replyToEmail);
      setInlineForwardDraft({
        to: restoreDraft.to,
        cc: restoreDraft.cc,
        htmlContent: restoreDraft.htmlContent,
        attachments: restoreDraft.attachments,
      });
      setShowInlineForward(true);
      setShowInlineReply(false);
      setReplyingToEmail(null);
    }

    clearRestoreDraft();

    // Scroll to the reply composer
    const tryFocus = (attempt: number) => {
      const el = document.getElementById('inline-reply-compose');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'end' });
        const editor = el.querySelector('.ProseMirror, [contenteditable="true"]') as HTMLElement;
        if (editor) {
          editor.focus();
          return;
        }
      }
      if (attempt < 5) {
        setTimeout(() => tryFocus(attempt + 1), 150);
      }
    };
    setTimeout(() => tryFocus(0), 100);
  }, [restoreDraft]);

  // Return null if nothing selected
  if (!selectedEmailId || !selectedEmail || !displayEmail) {
    return null;
  }

  const date = new Date(displayEmail.date * 1000);
  const isStarred = (displayEmail.tags || '').includes('|starred|');
  const senderInitials = getInitials(displayEmail.fromName, displayEmail.fromAddress);
  const avatarColor = getAvatarColor(displayEmail.fromAddress);

  // Detect if viewing Trash or Spam folder
  const selectedFolder = selectedFolderId ? folders.find((f: any) => f.id === selectedFolderId) : null;
  const folderPath = selectedFolder?.path?.toLowerCase() || '';
  const isInTrash = folderPath.includes('trash') || folderPath === 'deleted items' || (selectedFolder as any)?.specialUse === '\\Trash';
  const isInSpam = folderPath.includes('spam') || folderPath.includes('junk') || (selectedFolder as any)?.specialUse === '\\Junk';

  const attachments = parseAttachments(displayEmail.attachmentNames, displayEmail.attachmentSizes)
    .map((a) => ({
      name: a.name,
      size: a.size != null ? prettyBytes(a.size) : 'Unknown',
    }));

  const handleBack = () => {
    clearSelectedEmail();
  };

  const handleMarkRead = async () => {
    const markingUnread = isRead;
    // Gmail-style: the toolbar toggle acts on the WHOLE open conversation, not
    // just the shown message. Direction is still driven by the currently-shown
    // `isRead` (mark everything read, or everything unread). markAsRead is
    // optimistic locally; the IMAP flag writes are coalesced by the
    // OperationQueue.
    // allThreadEmails, never the collapsed list: a whole-conversation action has
    // to reach the duplicate copies we fold out of view, or deleting a thread
    // leaves six identical rows behind that the next sync brings straight back.
    const targets = allThreadEmails.length > 0 ? allThreadEmails : selectedEmail ? [selectedEmail] : [];
    for (const e of targets) {
      await markAsRead(e.id, !isRead);
    }
    // When marking as unread, go back to list view
    if (markingUnread) {
      clearSelectedEmail();
    }
  };

  // Gmail-style: the detail toolbar acts on the WHOLE open conversation, not
  // just the message currently shown. Single deleteEmail/archiveEmail
  // intentionally stay in the thread when siblings remain (so a single chat
  // bubble can be removed), which would leave the rest of the conversation
  // behind. Here we remove every message in the thread at once and advance to
  // the next thread (or close the detail if this was the last one). A
  // single-message thread keeps the per-message path so its undo toast +
  // built-in auto-advance are preserved.
  const removeWholeThread = async (action: 'delete' | 'archive' | 'notspam' | 'spam') => {
    // allThreadEmails, never the collapsed list: a whole-conversation action has
    // to reach the duplicate copies we fold out of view, or deleting a thread
    // leaves six identical rows behind that the next sync brings straight back.
    const targets = allThreadEmails.length > 0 ? allThreadEmails : selectedEmail ? [selectedEmail] : [];
    const ids = targets.map((e) => e.id);
    if (ids.length === 0) return;

    if (ids.length === 1) {
      if (action === 'delete') await deleteEmail(ids[0]);
      else if (action === 'archive') await archiveEmail(ids[0]);
      else if (action === 'spam') await moveToSpam(ids[0]);
      else await moveFromSpam(ids[0]);
      return;
    }

    const nextThread = hasNextEmail ? navigationThreads[currentThreadIndex + 1] : null;
    bulkRemoveEmails(ids, action);
    if (nextThread) {
      selectEmail((nextThread.firstUnreadEmail || nextThread.latestEmail).id);
    } else {
      clearSelectedEmail();
    }
  };

  const handleDelete = () => removeWholeThread('delete');

  const handleArchive = () => removeWholeThread('archive');

  const handleRemoveAICategory = async () => {
    if (selectedEmail) {
      try {
        const result = await (window as any).electronAPI.ai.removeCategory(selectedEmail.id);
        if (result.success) {
          if (viewingAICategory) {
            setEmails(emails.filter(e => e.id !== selectedEmail.id));
            clearSelectedEmail();
          }
          console.log('[EmailDetail] Removed AI category for email:', selectedEmail.id);
        }
      } catch (error) {
        console.error('[EmailDetail] Failed to remove AI category:', error);
      }
    }
  };

  const scrollToInlineReply = () => {
    const tryFocus = (attempt: number) => {
      const el = document.getElementById('inline-reply-compose');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'end' });
        const editor = el.querySelector('.ProseMirror, [contenteditable="true"]') as HTMLElement;
        if (editor) {
          editor.focus();
          return;
        }
      }
      // Retry up to 5 times with increasing delay (editor may not be mounted yet)
      if (attempt < 5) {
        setTimeout(() => tryFocus(attempt + 1), 150);
      }
    };
    setTimeout(() => tryFocus(0), 100);
  };

  const scrollToInlineForward = () => {
    const tryFocus = (attempt: number) => {
      const el = document.getElementById('inline-forward-compose');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'end' });
        // Focus the To input inside InlineForward
        const toInput = el.querySelector('input[type="text"]') as HTMLElement;
        if (toInput) {
          toInput.focus();
          return;
        }
      }
      if (attempt < 5) {
        setTimeout(() => tryFocus(attempt + 1), 150);
      }
    };
    setTimeout(() => tryFocus(0), 100);
  };

  const handleReply = (email = latestThreadEmail, usePopup = false) => {
    if (!email) return;
    if (usePopup) {
      openCompose('reply', {
        id: email.id,
        accountId: (email as any).accountId,
        subject: email.subject || '',
        fromAddress: email.fromAddress,
        fromName: email.fromName,
        toAddress: email.toAddress || '',
        ccAddress: email.ccAddress,
        date: email.date,
        cleanBody: email.cleanBody,
        rawBody: email.rawBody,
      });
    } else {
      setReplyingToEmail(email);
      setInlineReplyMode('reply');
      setShowInlineReply(true);
      setShowInlineForward(false);
      setForwardingEmail(null);
      scrollToInlineReply();
    }
  };

  const handleReplyAll = (email = latestThreadEmail, usePopup = false) => {
    if (!email) return;
    if (usePopup) {
      openCompose('replyAll', {
        id: email.id,
        accountId: (email as any).accountId,
        subject: email.subject || '',
        fromAddress: email.fromAddress,
        fromName: email.fromName,
        toAddress: email.toAddress || '',
        ccAddress: email.ccAddress,
        date: email.date,
        cleanBody: email.cleanBody,
        rawBody: email.rawBody,
      });
    } else {
      setReplyingToEmail(email);
      setInlineReplyMode('replyAll');
      setShowInlineReply(true);
      setShowInlineForward(false);
      setForwardingEmail(null);
      scrollToInlineReply();
    }
  };

  // Keep refs in sync so the event listeners always call latest handlers
  inlineReplyHandlerRef.current = (mode) => {
    if (mode === 'reply') handleReply(undefined, false);
    else handleReplyAll(undefined, false);
  };
  inlineForwardHandlerRef.current = () => {
    handleInlineForward();
  };

  // On ANY close — whether the user DISCARDED the draft or SENT the reply —
  // remember this thread for the session so the composer does NOT auto-reopen a
  // draft here again. Critical: draft delete (local + server) is async, and on
  // SEND the autosave/unmount-save of a re-opened composer can re-create the
  // draft AFTER deleteDraft() ran (the sent reply becomes the new latest email,
  // which slips past the per-email auto-open guard and re-triggers the open —
  // that racing re-save is exactly why a draft lingered in the Drafts folder
  // after a successful send). One draft per thread now, so there's no "next
  // draft" to surface anyway. Manual Reply still works (it doesn't consult this
  // set).
  const handleCloseInlineReply = (opts?: { dismissed?: boolean }) => {
    // Record EVERY key this view could later be recognised by, through the same
    // helper the auto-open check reads. Recording a single key and checking a
    // different one is what let a sent draft come back: the two sides picked
    // their key off different rows (the parent vs. the optimistic sent row), so
    // the set never matched.
    const threadKeys = threadKeysOf([
      replyingToEmail,
      latestThreadEmail,
      selectedEmail,
      ...threadEmails,
    ]);
    threadKeys.forEach((key) => dismissedThreadsRef.current.add(key));
    if (threadKeys.length > 0) {
      console.log(`[Draft] Marked thread handled for this session (${opts?.dismissed ? 'dismissed' : 'sent'}):`, threadKeys);
    }
    setShowInlineReply(false);
    setReplyingToEmail(null);
    setInlineReplyDraft(undefined);

    // When the DRAFT itself was the open item (opened from the Drafts list, or the
    // AI draft that auto-opened), CLOSING it — whether by SENDING or discarding —
    // deletes that draft row, so the selection points at a row that no longer
    // exists and the pane falls to the empty "Select an email to read" state.
    // Re-anchor the selection instead:
    //  - reply-draft in a real conversation → open that conversation's latest real
    //    message (after a send, that's the just-sent reply) so the thread the user
    //    was working in stays visible;
    //  - standalone draft (no surrounding thread) → return to the folder listing.
    // (When selectedEmail was NOT the draft — e.g. the composer auto-opened over
    //  an inbox thread — we leave the selection untouched: only the box closes.)
    if (selectedIsDraft) {
      const latestReal = threadEmails.length > 0
        ? [...threadEmails].sort((a, b) => b.date - a.date)[0]
        : null;
      if (latestReal) selectEmail(latestReal.id);
      else clearSelectedEmail();
    }
  };

  const handleForward = (email = selectedEmail) => {
    if (!email) return;
    openCompose('forward', {
      id: email.id,
      accountId: (email as any).accountId,
      subject: email.subject || '',
      fromAddress: email.fromAddress,
      fromName: email.fromName,
      toAddress: email.toAddress || '',
      ccAddress: email.ccAddress,
      date: email.date,
      cleanBody: email.cleanBody,
      rawBody: email.rawBody,
    });
  };

  const handleInlineForward = (email = latestThreadEmail) => {
    if (!email) return;
    setForwardingEmail(email);
    setShowInlineForward(true);
    setShowInlineReply(false);
    setReplyingToEmail(null);
    scrollToInlineForward();
  };

  const handleCloseInlineForward = () => {
    setShowInlineForward(false);
    setForwardingEmail(null);
  };

  const handlePrintEmail = (email: any) => {
    if (!email) return;
    const emailDate = new Date(email.date * 1000);
    const html = `<!DOCTYPE html>
      <html>
      <head>
        <title>Print Email - ${email.subject || '(no subject)'}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }
          .header { border-bottom: 1px solid #e5e7eb; padding-bottom: 20px; margin-bottom: 20px; }
          .subject { font-size: 24px; font-weight: bold; margin-bottom: 16px; }
          .meta { color: #6b7280; font-size: 14px; line-height: 1.6; }
          .meta strong { color: #374151; }
          .body { line-height: 1.6; }
          @media print { body { padding: 20px; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="subject">${email.subject || '(no subject)'}</div>
          <div class="meta">
            <div><strong>From:</strong> ${email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress}</div>
            <div><strong>To:</strong> ${email.toAddress || ''}</div>
            ${email.ccAddress ? `<div><strong>Cc:</strong> ${email.ccAddress}</div>` : ''}
            <div><strong>Date:</strong> ${emailDate.toLocaleString()}</div>
          </div>
        </div>
        <div class="body">${email.rawBody || email.cleanBody || '(no content)'}</div>
      </body>
      </html>`;

    // Print via a hidden, sandboxed iframe rather than window.open — the main
    // process denies all window.open (setWindowOpenHandler → 'deny'), so the old
    // popup returned null and printing silently did nothing. The `sandbox`
    // (no allow-scripts) blocks any JS in the email HTML from running; `allow-
    // modals` permits the print dialog; `allow-same-origin` lets us reach
    // contentWindow to trigger + clean up the print.
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin allow-modals');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;';
    iframe.srcdoc = html;
    iframe.onload = () => {
      const win = iframe.contentWindow;
      if (!win) { iframe.remove(); return; }
      const cleanup = () => { if (document.body.contains(iframe)) iframe.remove(); };
      win.addEventListener('afterprint', cleanup);
      try {
        win.focus();
        win.print();
      } catch (err) {
        console.error('[Print] failed:', err);
        cleanup();
      }
      // Fallback cleanup in case afterprint never fires (dialog dismissed oddly).
      setTimeout(cleanup, 60_000);
    };
    document.body.appendChild(iframe);
  };

  const handleDownloadEmail = async (email: any) => {
    if (!email) return;

    const emailDate = new Date(email.date * 1000);
    const headers = [
      `From: ${email.fromName ? `"${email.fromName}" <${email.fromAddress}>` : email.fromAddress}`,
      `To: ${email.toAddress || ''}`,
      email.ccAddress ? `Cc: ${email.ccAddress}` : '',
      `Subject: ${email.subject || '(no subject)'}`,
      `Date: ${emailDate.toUTCString()}`,
      `Message-ID: <${email.messageId || email.id}@sarvinbox.local>`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
    ].filter(Boolean).join('\r\n');

    const emlContent = headers + '\r\n' + (email.rawBody || email.cleanBody || '');
    const blob = new Blob([emlContent], { type: 'message/rfc822' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(email.subject || 'email').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50)}.eml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleShowOriginal = (email: any) => {
    if (!email) return;
    setShowOriginalEmail(email);
  };

  const handleReportSpam = async (emailId: string) => {
    await moveToSpam(emailId);
  };

  // Toolbar Report-spam acts on the WHOLE open conversation (mirrors
  // Delete/Archive). The per-message menus keep calling single handleReportSpam.
  const handleReportSpamThread = () => removeWholeThread('spam');

  // Snooze/unsnooze the WHOLE open conversation. Snooze is DB-only (no IMAP),
  // so a per-message loop is fine.
  const handleSnoozeThread = async (snoozeUntil: number) => {
    // allThreadEmails, never the collapsed list: a whole-conversation action has
    // to reach the duplicate copies we fold out of view, or deleting a thread
    // leaves six identical rows behind that the next sync brings straight back.
    const targets = allThreadEmails.length > 0 ? allThreadEmails : selectedEmail ? [selectedEmail] : [];
    for (const e of targets) {
      await snoozeEmail(e.id, snoozeUntil);
    }
  };

  const handleUnsnoozeThread = async () => {
    // allThreadEmails, never the collapsed list: a whole-conversation action has
    // to reach the duplicate copies we fold out of view, or deleting a thread
    // leaves six identical rows behind that the next sync brings straight back.
    const targets = allThreadEmails.length > 0 ? allThreadEmails : selectedEmail ? [selectedEmail] : [];
    for (const e of targets) {
      await unsnoozeEmail(e.id);
    }
  };

  // Apply a label toggle to every message in the open conversation. IMAP flag
  // writes are coalesced by the OperationQueue.
  const handleSetLabelThread = async (name: string, on: boolean) => {
    // allThreadEmails, never the collapsed list: a whole-conversation action has
    // to reach the duplicate copies we fold out of view, or deleting a thread
    // leaves six identical rows behind that the next sync brings straight back.
    const targets = allThreadEmails.length > 0 ? allThreadEmails : selectedEmail ? [selectedEmail] : [];
    for (const e of targets) {
      await setEmailLabel(e.id, name, on);
    }
  };

  // Move the WHOLE thread out of spam (not one message at a time). Mirrors the
  // whole-thread Delete/Archive behavior.
  const handleNotSpam = () => removeWholeThread('notspam');

  const handleRestore = async (emailId: string) => {
    const inboxFolder = folders.find((f: any) =>
      f.path === 'INBOX' || f.name?.toLowerCase() === 'inbox'
    );
    if (!inboxFolder) {
      console.error('[EmailDetail] Cannot restore: INBOX folder not found');
      return;
    }
    setIsRestoring(true);
    try {
      // Restore all emails in the thread (or just the single email if no thread)
      const idsToRestore = allThreadEmails.length > 1
        ? allThreadEmails.map(e => e.id)
        : [emailId];
      const acctId = useEmailStore.getState()._accountIdFor(emailId);
      for (const id of idsToRestore) {
        await window.electronAPI.emails.moveToFolder(id, inboxFolder.id, acctId);
      }
      // Remove from current view
      const idSet = new Set(idsToRestore);
      setEmails(emails.filter(e => !idSet.has(e.id)));
      clearSelectedEmail();
    } finally {
      setIsRestoring(false);
    }
  };

  const handleFilterLikeThis = (email: any) => {
    if (!email) return;
    alert(`Create filter for emails from: ${email.fromAddress}\n\nThis feature will be available in a future update.`);
  };

  const handleTranslate = (email: any) => {
    if (!email) return;
    const text = email.cleanBody || email.rawBody || '';
    const truncatedText = text.substring(0, 5000);
    const url = `https://translate.google.com/?sl=auto&tl=en&text=${encodeURIComponent(truncatedText)}`;
    window.open(url, '_blank');
  };

  const handleDetectSignature = async (email: any) => {
    if (!email) return;

    const isHtml = email.contentType === 'html';
    if (!isHtml) {
      alert('Signature detection only works with HTML emails.');
      return;
    }

    setSignatureDetectionEmail(email);
    setSignatureDetecting(true);
    setSignatureDetectionResult(null);

    try {
      const emailBody = email.rawBody || email.cleanBody || '';
      const senderEmail = email.fromAddress;
      const result = await detectSignature(emailBody, senderEmail, email.id);
      setSignatureDetectionResult(result);
    } catch (error) {
      console.error('[Signature Detection] Error:', error);
      setSignatureDetectionResult({
        hasSignature: false,
        htmlSelector: null,
        sampleHtml: null,
        signatureText: null,
        confidence: 'low',
        fromCache: false,
      });
    } finally {
      setSignatureDetecting(false);
    }
  };

  const handleSaveSignatureSelector = async () => {
    if (!signatureDetectionEmail || !signatureDetectionResult?.htmlSelector) return;

    try {
      await (window as any).electronAPI.signatures.save({
        email: signatureDetectionEmail.fromAddress,
        htmlSelector: signatureDetectionResult.htmlSelector,
        sampleHtml: signatureDetectionResult.sampleHtml || undefined,
        emailId: signatureDetectionEmail.id,
        confidence: signatureDetectionResult.confidence,
      });
      alert('Signature selector saved successfully!');
      setSignatureDetectionEmail(null);
      setSignatureDetectionResult(null);
    } catch (error) {
      console.error('[Signature Detection] Failed to save:', error);
      alert('Failed to save signature selector.');
    }
  };

  return {
    emails,
    selectedEmailId,
    threadEmails,
    duplicatesByEmailId,
    threadMessageTotal,
    loadingThread,
    loadingBodies,
    failedBodies,
    viewingAICategory,
    aiBoxActiveTab,
    selectedEmail,
    displayEmail,
    isStandaloneDraft,
    isRead,
    isStarred,
    isInTrash,
    isInSpam,
    date,
    senderInitials,
    avatarColor,
    attachments,
    showFullHeaders,
    setShowFullHeaders,
    expandedThreads,
    showFullContent,
    mainEmailExpanded,
    setMainEmailExpanded,
    showInlineReply,
    inlineReplyMode,
    setInlineReplyMode,
    replyingToEmail,
    inlineReplyDraft,
    showInlineForward,
    forwardingEmail,
    inlineForwardDraft,
    chatViewEnabled,
    chatViewActive,
    hasInlineConversation,
    conversationMessages,
    conversationLoading,
    conversationUpdating,
    conversationError,
    conversationPartial,
    conversationProgress,
    showAIView,
    setShowAIView,
    showSignatures,
    showOriginalEmail,
    setShowOriginalEmail,
    signatureDetectionEmail,
    setSignatureDetectionEmail,
    signatureDetectionResult,
    setSignatureDetectionResult,
    signatureDetecting,
    isRestoring,
    handleBack,
    handleMarkRead,
    handleDelete,
    handleArchive,
    handleRemoveAICategory,
    handleReply,
    handleReplyAll,
    handleForward,
    handleInlineForward,
    handleCloseInlineReply,
    handleCloseInlineForward,
    handlePrintEmail,
    handleDownloadEmail,
    handleShowOriginal,
    handleReportSpam,
    handleReportSpamThread,
    handleSnoozeThread,
    handleUnsnoozeThread,
    handleSetLabelThread,
    handleNotSpam,
    handleRestore,
    handleFilterLikeThis,
    handleTranslate,
    handleDetectSignature,
    handleSaveSignatureSelector,
    handleChatViewToggle,
    handleRetryConversation,
    handleReExtractMessage,
    toggleThread,
    toggleFullContent,
    toggleSignature,
    handleNextEmail,
    handlePreviousEmail,
    hasNextEmail,
    hasPreviousEmail,
    currentEmailPosition: currentThreadIndex + 1,
    totalEmailCount: getNavigationTotalCount(),
    markAsRead,
    deleteEmail,
    archiveEmail,
    fetchEmailBody,
    snoozeEmail,
    unsnoozeEmail,
    markAsStarred,
  };
}
