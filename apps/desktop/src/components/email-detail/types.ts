import type { SignatureDetectionResult } from '../../services/ai-service';
import type { ConversationMessage } from '../../services/conversation-service';

export type { ConversationMessage };

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
  inlineReplyDraft?: { to: string; cc: string; htmlContent: string; attachments: any[] };
  showInlineForward: boolean;
  forwardingEmail: any | null;
  inlineForwardDraft?: { to: string; cc: string; htmlContent: string; attachments: any[] };
  chatViewEnabled: boolean;
  /**
   * True when the rendering tree should swap EmailCard for ThreadChatView —
   * either a real multi-email thread, a single email with an embedded
   * conversation (loop-me-in / forward), or a still-loading thread.
   */
  chatViewActive: boolean;
  /** True for a single-email view whose body contains a quoted/forwarded conversation. */
  hasInlineConversation: boolean;
  conversationMessages: ConversationMessage[] | null;
  conversationLoading: boolean;
  conversationUpdating: boolean;
  conversationError: string | null;
  /** True if AI extraction fell back to DOM cleaning for at least one email. */
  conversationPartial: boolean;
  /**
   * Progressive-extraction counters — non-null only while an
   * extraction run is in flight (done/total = extracted-email counts;
   * status = optional human-readable note like "AI provider busy —
   * retrying in 8s"). Shape and name are frozen for the UI layer.
   */
  conversationProgress: { done: number; total: number; status?: string } | null;
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
  handleRetryConversation: () => void;
  handleReExtractMessage: (messageId: string) => Promise<void>;
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
