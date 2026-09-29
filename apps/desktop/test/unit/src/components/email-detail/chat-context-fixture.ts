// The chat-view fields of an EmailDetailContext, derived from a thread the way
// useEmailDetail derives them — shared by every ThreadChatView suite.
//
// Shared rather than stubbed per suite: the chat view no longer splits the
// thread itself (useEmailDetail hands it Standard's turns, and the AI view's
// composition), so a suite that invented those fields would test a pipeline the
// app does not have. These are the real `threadTurns` / `composeAiTurns`.
import type { EmailRecord } from '@sarvinbox/core';
import { compareConversationOrder } from '@sarvinbox/core/conversation-membership';
import type { FirstSplitPart, FirstSplitRow } from '@sarvinbox/core/first-split';
import { vi } from 'vitest';

import { composeAiTurns } from '../../../../../src/components/email-detail/ai-view-compose';
import { threadTurns } from '../../../../../src/components/email-detail/chat-message-adapter';
import type { ChatViewRules } from '../../../../../src/components/email-detail/chat-view-rules';
import type { FirstEmailSplit } from '../../../../../src/components/email-detail/hooks/useFirstEmailSplit';

import { ME } from './email-fixture';

/** A multi-email thread read in chat with no AI configured: Standard only. */
export const STANDARD_RULES: ChatViewRules = {
  eligibility: 'none',
  offerChat: true,
  chatActive: true,
  showAiToggle: false,
  autoRunAI: false,
  aiAvailable: false,
};

/** No split known, nothing running. */
export const idleSplit = (): FirstEmailSplit => ({
  state: 'unknown',
  row: null,
  parts: null,
  usable: false,
  running: false,
  status: null,
  automaticRunAllowed: true,
  lastManualRun: null,
  run: vi.fn(async () => {}),
});

/** A stored split row for `parts` (status ok, or partial when any part is a fallback). */
export const splitRow = (parts: FirstSplitPart[], over: Partial<FirstSplitRow> = {}): FirstSplitRow => ({
  threadId: 't1',
  firstKey: 'k',
  firstEmailId: 'e1',
  sourceFingerprint: 'f',
  splitVersion: 1,
  status: parts.some((part) => part.fallback) ? 'partial' : 'ok',
  quoteCount: parts.filter((part) => part.role === 'quote').length,
  parts: JSON.stringify(parts),
  errorKind: null,
  attempts: 0,
  nextRetryAt: null,
  modelUsed: 'openai:p1:gpt-x',
  updatedAt: 0,
  ...over,
});

export interface ChatFieldsOptions {
  chatRules?: Partial<ChatViewRules>;
  firstSplit?: Partial<FirstEmailSplit>;
  /** A usable split's parts: `aiTurns` is composed from them and the split is `usable`. */
  parts?: FirstSplitPart[] | null;
  currentUserEmail?: string;
}

/**
 * `standardTurns`, `aiTurns`, `firstEmail`, `chatRules`, `firstSplit`,
 * `polishThreadContext` and `currentUserEmail` for `threadEmails` — Standard's
 * real split and, with `parts`, the AI view's real composition.
 */
export function chatFieldsFor(threadEmails: readonly EmailRecord[], options: ChatFieldsOptions = {}) {
  const currentUserEmail = options.currentUserEmail ?? ME;
  const standardTurns = threadTurns(threadEmails, { currentUserEmail });
  const firstEmail = [...threadEmails].sort(compareConversationOrder)[0] ?? null;
  const parts = options.parts ?? null;
  const aiTurns = parts && parts.length > 0 && firstEmail
    ? composeAiTurns({ standard: standardTurns, first: firstEmail, parts, currentUserEmail })
    : null;
  const usable: Partial<FirstEmailSplit> = aiTurns
    ? { state: 'usable', parts, usable: true, row: splitRow(parts!) }
    : {};
  return {
    standardTurns,
    aiTurns,
    firstEmail,
    chatRules: { ...STANDARD_RULES, ...options.chatRules },
    firstSplit: { ...idleSplit(), ...usable, ...options.firstSplit },
    polishThreadContext: '',
    currentUserEmail,
  };
}
