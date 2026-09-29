// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { chatMountsComposer } from '../../../../../src/components/email-detail/chat-view-rules';
import { render, toggle, type Mounted } from '../../../../helpers/render';

import { ELEVEN_AM, email, TEN_AM } from './email-fixture';

/**
 * What the reading pane itself mounts around the conversation: the List/Chat
 * switch, and the reply and forward boxes for the thread's first message.
 *
 * What breaks if this file goes red: two composers on one reply — each
 * autosaving its own draft, under one element id the focus lookup picks
 * between — or none at all, a Reply that opens nothing. The pane and the chat
 * view split the boxes between them by one rule (`chatMountsComposer`); this
 * pins the pane's half to it. And the switch: showing the wrong view as on, or
 * flipping to the wrong one.
 */

// The pane's children stand in; this file is about what the pane mounts.
const mountedComposers: string[] = [];
vi.mock('../../../../../src/components/InlineReply', () => ({
  InlineReply: (props: { replyToEmail: { id: string } }) => {
    mountedComposers.push(`reply:${props.replyToEmail.id}`);
    return <div data-testid="inline-reply" />;
  },
}));
vi.mock('../../../../../src/components/InlineForward', () => ({
  InlineForward: (props: { forwardEmail: { id: string } }) => {
    mountedComposers.push(`forward:${props.forwardEmail.id}`);
    return <div data-testid="inline-forward" />;
  },
}));
vi.mock('../../../../../src/components/email-detail/EmailToolbar', () => ({ EmailToolbar: () => null }));
vi.mock('../../../../../src/components/email-detail/EmailCard', () => ({ EmailCard: () => null }));
vi.mock('../../../../../src/components/email-detail/ThreadChatView', () => ({ ThreadChatView: () => null }));
vi.mock('../../../../../src/components/email-detail/ThreadList', () => ({ ThreadList: () => null }));
vi.mock('../../../../../src/components/email-detail/FollowUpBanner', () => ({ FollowUpBanner: () => null }));
vi.mock('../../../../../src/components/email-detail/ShowOriginalModal', () => ({ ShowOriginalModal: () => null }));
vi.mock('../../../../../src/components/email-detail/SignatureDetectionModal', () => ({
  SignatureDetectionModal: () => null,
}));
vi.mock('../../../../../src/components/email-detail/chat-prewarm', () => ({ useChatPrewarm: () => {} }));
vi.mock('../../../../../src/components/ThreadSummary', () => ({ ThreadSummary: () => null }));
vi.mock('../../../../../src/components/LabelChips', () => ({ LabelChips: () => null }));
vi.mock('../../../../../src/services/ai-service', () => ({
  buildPolishThreadContext: () => '',
  getCurrentUserEmail: () => 'me@acme.example',
}));
vi.mock('../../../../../src/store/helpers', () => ({ accountDisplayLabel: () => '' }));
const storeState = {
  setEmailLabel: vi.fn(),
  selectedVirtualFolder: null,
  viewAccountId: null,
  accounts: [],
  pendingThreadEmailIds: [] as string[],
  showPendingThreadMessages: vi.fn(),
  dismissPendingThreadMessages: vi.fn(),
};
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: (select: (state: typeof storeState) => unknown) => select(storeState),
}));
let ctx: Record<string, unknown> = {};
vi.mock('../../../../../src/components/email-detail/hooks/useEmailDetail', () => ({
  useEmailDetail: () =>
    new Proxy(ctx, { get: (target, key) => (key in target ? target[key as string] : vi.fn()) }),
}));

const { EmailDetail } = await import('../../../../../src/components/email-detail/EmailDetail');

const ANCHOR = email({ id: 'anchor', date: TEN_AM });
const LATER = email({ id: 'later', date: ELEVEN_AM });

/** A two-message thread's context, with every flag the pane reads spelled out
 *  (the Proxy's fallback is a `vi.fn()`, and a function is truthy). */
const threadContext = (overrides: Record<string, unknown> = {}) => ({
  displayEmail: ANCHOR,
  isStandaloneDraft: false,
  threadEmails: [ANCHOR, LATER] as EmailRecord[],
  threadMessageTotal: 2,
  loadingThread: false,
  chatViewEnabled: false,
  chatViewActive: false,
  hasInlineConversation: false,
  showInlineReply: false,
  replyingToEmail: null,
  inlineReplyMode: 'reply',
  inlineReplyDraft: undefined,
  showInlineForward: false,
  forwardingEmail: null,
  inlineForwardDraft: undefined,
  conversationMessages: null,
  showOriginalEmail: null,
  signatureDetectionEmail: null,
  signatureDetectionResult: null,
  signatureDetecting: false,
  handleChatViewToggle: vi.fn(),
  ...overrides,
});

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  mountedComposers.length = 0;
});

const mountWith = (overrides: Record<string, unknown>) => {
  ctx = threadContext(overrides);
  mounted = render(<EmailDetail />);
  return mounted;
};

describe('EmailDetail — the List/Chat switch', () => {
  // Regression guard for the wiring: the switch shows the view that is on,
  // and asks for the one clicked.
  it('marks the list as on in the standard view, and switches to chat', () => {
    const view = mountWith({ chatViewEnabled: false });
    expect(view.byLabel('List view')!.getAttribute('aria-pressed')).toBe('true');
    expect(view.byLabel('Chat view')!.getAttribute('aria-pressed')).toBe('false');
    toggle(view.byLabel('Chat view'));
    expect((ctx.handleChatViewToggle as ReturnType<typeof vi.fn>).mock.calls).toEqual([[true]]);
  });

  it('marks the chat as on in the chat view, and switches to the list', () => {
    const view = mountWith({ chatViewEnabled: true, chatViewActive: true });
    expect(view.byLabel('Chat view')!.getAttribute('aria-pressed')).toBe('true');
    toggle(view.byLabel('List view'));
    expect((ctx.handleChatViewToggle as ReturnType<typeof vi.fn>).mock.calls).toEqual([[false]]);
  });
});

describe('EmailDetail — the first message\'s reply and forward boxes', () => {
  const cases = [
    { chatViewActive: false, target: ANCHOR },
    { chatViewActive: false, target: LATER },
    { chatViewActive: true, target: ANCHOR },
    { chatViewActive: true, target: LATER },
  ];

  // THE invariant: the pane mounts a box exactly when the chat view does not
  // (one rule, read by both). Two boxes autosave two drafts of one reply;
  // none is a Reply that opens nothing.
  it.each(cases)(
    'mounts the reply exactly when the chat does not (chat active: $chatViewActive, on $target.id)',
    ({ chatViewActive, target }) => {
      mountWith({ chatViewActive, showInlineReply: true, replyingToEmail: target });
      const chatTakesIt = chatMountsComposer({ chatViewActive, targetId: target.id, anchorId: ANCHOR.id });
      expect(mountedComposers.includes(`reply:${target.id}`)).toBe(!chatTakesIt);
    },
  );

  it.each(cases)(
    'mounts the forward exactly when the chat does not (chat active: $chatViewActive, on $target.id)',
    ({ chatViewActive, target }) => {
      mountWith({ chatViewActive, showInlineForward: true, forwardingEmail: target });
      const chatTakesIt = chatMountsComposer({ chatViewActive, targetId: target.id, anchorId: ANCHOR.id });
      expect(mountedComposers.includes(`forward:${target.id}`)).toBe(!chatTakesIt);
    },
  );

  // Pinned concretely too, so a wrong rule cannot pass by agreeing with itself:
  // under the standard card, the pane owns the first message's box.
  it('mounts the first message\'s reply under the standard card', () => {
    mountWith({ showInlineReply: true, replyingToEmail: ANCHOR });
    expect(mountedComposers).toContain('reply:anchor');
  });

  it('leaves every box to the chat while the chat is the reading surface', () => {
    mountWith({ chatViewActive: true, showInlineReply: true, replyingToEmail: ANCHOR });
    expect(mountedComposers).toEqual([]);
  });
});
