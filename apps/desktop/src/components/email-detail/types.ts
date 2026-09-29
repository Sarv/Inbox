import type { ChatMessage } from '@sarv-in/email-chat-view';
import type { EmailRecord } from '@sarvinbox/core';

import type { SignatureDetectionResult } from '../../services/ai-service';

import type { StandardTurns } from './chat-message-adapter';
import type { ChatViewRules } from './chat-view-rules';
import type { FirstEmailSplit } from './hooks/useFirstEmailSplit';

export interface EmailDetailContext {
  // Store values
  emails: any[];
  selectedEmailId: string | null;
  threadEmails: any[];
  /** Identical copies folded behind a visible message, keyed by its id. Only
   *  messages that actually hide copies appear here. */
  duplicatesByEmailId: Map<string, { id: string; date: number }[]>;
  /** Every real message in the conversation, INCLUDING the copies folded out of
   *  `threadEmails`. This is the number the list row's "(N)" shows, so the
   *  thread header must use it or the two disagree. */
  threadMessageTotal: number;
  loadingThread: boolean;
  loadingBodies: Set<string>;
  failedBodies: Set<string>;
  viewingAICategory: string | null;
  aiBoxActiveTab: string | null;

  // Computed
  selectedEmail: any | undefined;
  displayEmail: any | undefined;
  isStandaloneDraft: boolean;
  isRead: boolean;
  isStarred: boolean;
  isInTrash: boolean;
  isInSpam: boolean;
  date: Date;
  senderInitials: string;
  avatarColor: string;
  attachments: { name: string; size: string }[];

  // UI state
  showFullHeaders: boolean;
  setShowFullHeaders: (v: boolean) => void;
  expandedThreads: Set<string>;
  showFullContent: Set<string>;
  mainEmailExpanded: boolean;
  setMainEmailExpanded: (v: boolean) => void;
  showInlineReply: boolean;
  inlineReplyMode: 'reply' | 'replyAll';
  setInlineReplyMode: (mode: 'reply' | 'replyAll') => void;
  replyingToEmail: any | null;
  /** The open reply's seed draft — only ever the one written for
   *  `replyingToEmail` (see composer-target.ts). `draftMessageId` is the stored
   *  draft the composer replaces on save and deletes on send or discard. */
  inlineReplyDraft?: {
    to: string;
    cc: string;
    subject?: string;
    htmlContent: string;
    attachments: any[];
    draftMessageId?: string;
    unsaved?: boolean;
    isAIDraft?: boolean;
    aiReasoning?: string;
    agentDecisionId?: string;
  };
  showInlineForward: boolean;
  forwardingEmail: any | null;
  /** The open forward's seed draft, on the same terms, for `forwardingEmail`. */
  inlineForwardDraft?: {
    to: string;
    cc: string;
    htmlContent: string;
    attachments: any[];
    draftMessageId?: string;
    unsaved?: boolean;
  };
  /** The reader's chat-view setting for this email (auto setting, or the toggle). */
  chatViewEnabled: boolean;
  /**
   * The chat IS the reading surface — `chatRules.chatActive`: the thread
   * section renders ThreadChatView and EmailCard hides, never both.
   */
  chatViewActive: boolean;
  /** The chat view's decisions for this thread (chatViewRulesFor) — every consumer reads these. */
  chatRules: ChatViewRules;
  /** The thread's first member as the pane shows it — the email the AI view splits. */
  firstEmail: EmailRecord | null;
  /** The first email's split: the cache's state, its parts, runs, and the reader's run. */
  firstSplit: FirstEmailSplit;
  /**
   * Standard's turns for the thread (threadTurns), or null where nothing
   * needs them (a multi-email thread read as a list with no composer open).
   */
  standardTurns: StandardTurns | null;
  /** The AI view's turns — Standard's with the first email's slot replaced; null without a usable split. */
  aiTurns: ChatMessage[] | null;
  /**
   * The whole-thread transcript for reply polish, built once for every
   * composer; '' while no reply or forward is open.
   */
  polishThreadContext: string;
  /**
   * The reader's own address for this thread (getCurrentUserEmail on the
   * card's recipient) — resolved once here, so the chat's "me" side, the
   * prewarm and Standard's turns can never disagree about who the reader is.
   */
  currentUserEmail: string;
  showAIView: boolean;
  setShowAIView: (v: boolean) => void;
  showSignatures: Set<string>;
  showOriginalEmail: any | null;
  setShowOriginalEmail: (v: any | null) => void;
  signatureDetectionEmail: any | null;
  setSignatureDetectionEmail: (v: any | null) => void;
  signatureDetectionResult: SignatureDetectionResult | null;
  setSignatureDetectionResult: (v: SignatureDetectionResult | null) => void;
  signatureDetecting: boolean;
  isRestoring: boolean;

  // Handlers
  handleBack: () => void;
  handleMarkRead: () => Promise<void>;
  handleDelete: () => Promise<void>;
  handleArchive: () => Promise<void>;
  handleRemoveAICategory: () => Promise<void>;
  handleReply: (email?: any, usePopup?: boolean) => void;
  handleReplyAll: (email?: any, usePopup?: boolean) => void;
  handleForward: (email?: any) => void;
  handleInlineForward: (email?: any) => void;
  handleCloseInlineReply: () => void;
  handleCloseInlineForward: () => void;
  handlePrintEmail: (email: any) => void;
  handleDownloadEmail: (email: any) => void;
  handleShowOriginal: (email: any) => void;
  handleReportSpam: (emailId: string) => Promise<void>;
  /** Report-spam for the WHOLE open conversation (toolbar). */
  handleReportSpamThread: () => Promise<void>;
  /** Snooze every message in the open conversation. */
  handleSnoozeThread: (snoozeUntil: number) => Promise<void>;
  /** Unsnooze every message in the open conversation. */
  handleUnsnoozeThread: () => Promise<void>;
  /** Toggle a label on every message in the open conversation. */
  handleSetLabelThread: (name: string, on: boolean) => Promise<void>;
  handleNotSpam: () => Promise<void>;
  handleRestore: (emailId: string) => Promise<void>;
  handleFilterLikeThis: (email: any) => void;
  handleTranslate: (email: any) => void;
  handleDetectSignature: (email: any) => Promise<void>;
  handleSaveSignatureSelector: () => Promise<void>;
  handleChatViewToggle: (enabled: boolean) => void;
  toggleThread: (threadId: string) => void;
  toggleFullContent: (emailId: string) => void;
  toggleSignature: (emailId: string) => void;

  // Navigation
  handleNextEmail: () => void;
  handlePreviousEmail: () => void;
  hasNextEmail: boolean;
  hasPreviousEmail: boolean;
  currentEmailPosition: number;
  totalEmailCount: number;

  // Store actions (passed through)
  markAsRead: (emailId: string, read: boolean) => Promise<void>;
  deleteEmail: (emailId: string) => Promise<void>;
  archiveEmail: (emailId: string) => Promise<void>;
  fetchEmailBody: (emailId: string) => void;
  snoozeEmail: (emailId: string, snoozeUntil: number) => Promise<void>;
  unsnoozeEmail: (emailId: string) => Promise<void>;
  markAsStarred: (emailId: string, starred: boolean) => Promise<void>;
}
