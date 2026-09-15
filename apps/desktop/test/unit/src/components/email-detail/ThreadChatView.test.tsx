// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../../../../helpers/render';

import { ELEVEN_AM, email, TEN_AM } from './email-fixture';

/**
 * The thread's messages, in the chat view.
 *
 * What breaks if this file goes red: the phishing warning goes back to being
 * rendered in exactly ONE place — the anchor card, which shows the thread's
 * OLDEST message — so a spoofed message anywhere else in the conversation
 * warned about nothing at all.
 */

// A stand-in for the chat library: it renders the messages it is handed and
// calls the per-message slots, which is all this component asks of it. The real
// one builds sandboxed frames and measures them.
vi.mock('@sarv-in/email-chat-view', () => ({
  MailChatView: ({
    messages,
    renderFooter,
  }: {
    messages: readonly { id: string; body: string }[];
    renderFooter?: (message: { id: string }) => unknown;
  }) => (
    <div data-testid="chat-view">
      {messages.map((message) => (
        <div key={message.id} data-testid="bubble" data-message-id={message.id}>
          <div data-testid="bubble-body" dangerouslySetInnerHTML={{ __html: message.body }} />
          {renderFooter?.(message) as never}
        </div>
      ))}
    </div>
  ),
}));

vi.mock('../../../../../src/components/email-detail/EmailMenu', () => ({
  EmailMenu: () => <div data-testid="menu" />,
}));
vi.mock('../../../../../src/components/InlineReply', () => ({ InlineReply: () => null }));
vi.mock('../../../../../src/components/InlineForward', () => ({ InlineForward: () => null }));
vi.mock('../../../../../src/components/attachment-viewer/AttachmentViewer', () => ({
  AttachmentViewer: () => null,
}));
vi.mock('../../../../../src/components/attachment-viewer/useAttachmentActions', () => ({
  useAttachmentActions: () => ({ saveCopy: vi.fn() }),
}));
vi.mock('../../../../../src/services/ai-service', () => ({
  buildPolishThreadContext: () => '',
  getCurrentUserEmail: () => 'me@acme.example',
}));
vi.mock('../../../../../src/services/image-cache', () => ({
  resolveRefsInHtml: (html: string) => html,
}));
vi.mock('../../../../../src/store/helpers', () => ({
  qualifiesForSafeAutoLoad: () => false,
  shouldAutoLoadRemoteImages: () => false,
}));

const storeState = {
  failedBodies: new Set<string>(),
  fetchEmailBody: vi.fn(),
  markMessageStarred: vi.fn(),
  clearSelectedEmail: vi.fn(),
};
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: Object.assign(
    (select: (state: typeof storeState) => unknown) => select(storeState),
    { getState: () => storeState, setState: vi.fn() },
  ),
}));

const { ThreadChatView } = await import('../../../../../src/components/email-detail/ThreadChatView');

/** A designed template: a fixed-width layout table on a white card — exactly
 *  the shape the bubble treatment destroys. */
const KEKA_BODY =
  '<table width="600" bgcolor="#ffffff"><tr><td>Daily Email Digest for 15 Sep</td></tr></table>';

const KEKA = email({
  id: 'keka-1',
  date: TEN_AM,
  fromName: 'Sarv.com',
  fromAddress: 'no-reply@kekamail.com',
  rawBody: KEKA_BODY,
  tags: '|INBOX|bulk|',
});

const HUMAN = email({
  id: 'human-1',
  date: TEN_AM,
  fromName: 'Alice Chen',
  fromAddress: 'alice@acme.example',
  messageId: '<a1@mail.gmail.com>',
  rawBody: '<p>Kicking this off.</p>',
});

/** A ThreadChatView context: the fields it reads, stubs for every handler.
 *  The booleans are spelled out because a Proxy fallback returns a function,
 *  and a function is truthy. */
const context = (threadEmails: EmailRecord[]) =>
  new Proxy(
    {
      displayEmail: threadEmails[0],
      threadEmails,
      conversationMessages: null,
      conversationLoading: false,
      conversationError: null,
      conversationProgress: null,
      showAIView: false,
      showInlineReply: false,
      showInlineForward: false,
      replyingToEmail: null,
      forwardingEmail: null,
      inlineReplyDraft: null,
      inlineReplyMode: 'reply',
      handleReExtractMessage: undefined,
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : vi.fn()) },
  ) as never;

describe('ThreadChatView', () => {
  // Regression: the warning used to exist only on the thread's anchor card, so
  // a spoofed message anywhere else in the chat showed nothing. Every bubble
  // now carries its own.
  it('warns inside the bubble of a spoofed message', () => {
    const spoof = email({
      id: 'spoof-1',
      date: ELEVEN_AM,
      // A display name naming a domain the mail did not come from.
      fromName: 'security@paypal.com',
      fromAddress: 'bob@acme.example',
      messageId: '<s1@mail.gmail.com>',
      rawBody: '<p>Confirm your account.</p>',
    });
    const view = render(<ThreadChatView ctx={context([HUMAN, spoof])} />);
    const alert = view.find('[role="alert"]')!;
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain('paypal.com');
    view.unmount();
  });

  // Per message, not per thread: the genuine messages around it must stay
  // unmarked, or the warning stops naming anything.
  it('warns on the spoofed message only', () => {
    const spoof = email({
      id: 'spoof-1',
      date: ELEVEN_AM,
      fromName: 'security@paypal.com',
      fromAddress: 'bob@acme.example',
      messageId: '<s1@mail.gmail.com>',
      rawBody: '<p>Confirm your account.</p>',
    });
    const view = render(<ThreadChatView ctx={context([HUMAN, spoof])} />);
    expect(view.all('[role="alert"]')).toHaveLength(1);
    view.unmount();
  });

  // A banner that fires on ordinary mail is a banner people stop reading.
  it('shows no warning on an ordinary thread', () => {
    const view = render(<ThreadChatView ctx={context([HUMAN])} />);
    expect(view.find('[role="alert"]')).toBeNull();
    expect(view.all('[data-testid="bubble"]').length).toBeGreaterThan(0);
    view.unmount();
  });

  // A notification is a bubble like everything else: the as-sent treatment was
  // reverted, so nothing in this view may special-case a bulk sender.
  it('leaves a no-reply notification in the chat like any other message', () => {
    const view = render(<ThreadChatView ctx={context([KEKA])} />);
    expect(view.all('[data-testid="bubble"]').length).toBeGreaterThan(0);
    view.unmount();
  });

  // An empty thread still has to render the view (its loading and empty states
  // live there), rather than collapsing to nothing.
  it('still renders the chat view when the thread is empty', () => {
    const view = render(<ThreadChatView ctx={context([])} />);
    expect(view.find('[data-testid="chat-view"]')).not.toBeNull();
    view.unmount();
  });
});
