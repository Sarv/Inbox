// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../../../../helpers/render';

import { ELEVEN_AM, email, TEN_AM } from './email-fixture';

/**
 * The thread's messages, in the chat view.
 *
 * What breaks if this file goes red: the chat view stops being a reading
 * surface. Either the app's own phishing banner comes back under every bubble
 * — noise that teaches people to ignore the warning where it counts, in the
 * standard view — or a machine-sent designed mail goes back to being run
 * through the conversational strip chain and reaches the reader as a wireframe
 * with its footer, logo and QR code deleted.
 */

// A stand-in for the chat library: it renders the messages it is handed and
// calls the per-message slots, which is all this component asks of it. The real
// one builds sandboxed frames and measures them.
vi.mock('@sarv-in/email-chat-view', async (importOriginal) => ({
  // Only the view is stubbed. The rest of the module is real, because the
  // adapter asks it the same questions the view would — whether the thread
  // reads as a conversation, whether a body is designed — and a stub that
  // answered them differently would test a pipeline the app does not have.
  ...(await importOriginal<Record<string, unknown>>()),
  MailChatView: ({
    messages,
    renderHeaderMeta,
    renderFooter,
  }: {
    messages: readonly { id: string; body: string }[];
    renderHeaderMeta?: (message: { id: string }) => unknown;
    renderFooter?: (message: { id: string }) => unknown;
  }) => (
    <div data-testid="chat-view">
      {messages.map((message) => (
        <div key={message.id} data-testid="bubble" data-message-id={message.id}>
          {/* The real header is sender, recipients, then the time — the mock
              keeps only the time, because the time is what the meta slot has
              to land after. */}
          <div data-testid="bubble-head">
            <time data-testid="bubble-time">10:00</time>
            {renderHeaderMeta?.(message) as never}
          </div>
          <div data-testid="bubble-body" dangerouslySetInnerHTML={{ __html: message.body }} />
          <div data-testid="bubble-footer">{renderFooter?.(message) as never}</div>
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

/** A designed template: a layout table on a white card, then the app-badge
 *  footer — the exact block `signature:logo-strip` deletes, which is what made
 *  this mail arrive in the chat as a wireframe. */
const KEKA_BODY = [
  '<table width="600" bgcolor="#ffffff" role="presentation"><tr><td>',
  'Daily Email Digest for 15 Sep',
  '</td></tr></table>',
  '<table role="presentation"><tr><td>',
  '<a href="https://example.test/ios"><img src="https://cdn.example.test/appstore.png" alt="App Store"></a>',
  '<a href="https://example.test/android"><img src="https://cdn.example.test/play.png" alt="Google Play"></a>',
  '</td></tr></table>',
].join('');

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
  /** A spoof: a display name naming a domain the mail did not come from. */
  const SPOOF = email({
    id: 'spoof-1',
    date: ELEVEN_AM,
    fromName: 'security@paypal.com',
    fromAddress: 'bob@acme.example',
    messageId: '<s1@mail.gmail.com>',
    rawBody: '<p>Confirm your account.</p>',
  });

  // Regression: the app's phishing banner used to render under every bubble
  // here. The chat view is the reading surface and the standard view is where a
  // reader checks who a mail is really from — a warning under each of forty
  // bubbles is how people learn to ignore it there.
  it('shows no phishing warning, not even on a spoofed message', () => {
    const view = render(<ThreadChatView ctx={context([HUMAN, SPOOF])} />);
    expect(view.all('[role="alert"]')).toHaveLength(0);
    view.unmount();
  });

  // Dropping the banner must not drop the message with it: the spoofed mail is
  // still shown, it is just no longer annotated in this view.
  it('still renders the spoofed message as an ordinary bubble', () => {
    const view = render(<ThreadChatView ctx={context([HUMAN, SPOOF])} />);
    expect(view.all('[data-testid="bubble"]')).toHaveLength(2);
    view.unmount();
  });

  // Regression: the strip chain used to run on this body and delete its footer
  // table, logo and QR code — content vanishing with no explanation. A
  // machine-sent designed mail reaches the bubble byte for byte.
  it('renders a no-reply notification as sent, inside the chat', () => {
    const view = render(<ThreadChatView ctx={context([KEKA])} />);
    const bubble = view.find('[data-message-id="keka-1"]')!;
    expect(bubble).not.toBeNull();
    // Still a bubble in the same chat, not a separate full-width reader.
    expect(view.all('[data-testid="bubble"]')).toHaveLength(1);
    expect(bubble.querySelector('table[bgcolor]')).not.toBeNull();
    expect(bubble.textContent).toContain('Daily Email Digest');
    // The footer the strip chain used to delete, images and all.
    expect(bubble.querySelectorAll('img')).toHaveLength(2);
    view.unmount();
  });

  /** A login alert: the header card and the striped detail table that carry all
   *  of its meaning, followed by a block the splitter reads as a quoted turn. */
  const LOGIN_BODY = [
    '<table width="600" bgcolor="#ffffff" role="presentation"><tr><td bgcolor="#2563eb">',
    '<h1>New Login Detected</h1>',
    '</td></tr><tr><td>',
    '<table role="presentation"><tr bgcolor="#f5f5f5"><th>Time</th><td>11:57 am IST</td></tr>',
    '<tr><th>IP address</th><td>103.255.103.3</td></tr>',
    '<tr bgcolor="#f5f5f5"><th>Device</th><td>Chrome on macOS</td></tr></table>',
    '</td></tr></table>',
    // The attribution line the splitter reads as the start of a quoted turn —
    // a notification that repeats the previous one really does carry it.
    '<div class="gmail_quote"><div dir="ltr" class="gmail_attr">',
    'On Tue, 3 Mar 2026 at 09:00, Sarv Digital &lt;no-reply@digtalmarketing.in&gt; wrote:<br>',
    '</div><blockquote class="gmail_quote">',
    '<div dir="ltr">A previous login was detected from another device in another city.</div>',
    '</blockquote></div>',
  ].join('');

  const LOGIN = email({
    id: 'login-1',
    date: TEN_AM,
    fromName: 'Sarv Digital',
    fromAddress: 'no-reply@digtalmarketing.in',
    messageId: '<l1@digtalmarketing.in>',
    rawBody: LOGIN_BODY,
    tags: '|INBOX|bulk|',
  });

  // Regression: this mail reached the reader as TWO bubbles, both stripped to
  // bare headings and text lines — the splitter found a quoted turn in it, and
  // a designed mail that split was abandoned rather than restored. One bubble,
  // carrying the header card and the striped detail table the alert is made of.
  it('renders a login notification that quotes itself as one as-sent bubble', () => {
    const view = render(<ThreadChatView ctx={context([LOGIN])} />);
    const bubbles = view.all('[data-testid="bubble"]');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.querySelector('td[bgcolor="#2563eb"]')).not.toBeNull();
    expect(bubbles[0]!.querySelectorAll('th')).toHaveLength(3);
    expect(bubbles[0]!.textContent).toContain('103.255.103.3');
    view.unmount();
  });

  /** The shield, wherever it ended up: its level attribute while it has a
   *  verdict, its pending attribute while the body is still arriving. */
  const shieldIn = (element: Element) =>
    element.querySelector('[data-security-level], [data-security-pending]');

  // Regression: the shield sat under the body, on a row of its own. Down there
  // a mark that JUDGES the message reads as part of what the sender wrote —
  // the header line is where a reader is already looking to answer "who is this
  // from, and when", and a verdict on that answer belongs beside it.
  it('puts the security shield on the header line, after the time', () => {
    const view = render(<ThreadChatView ctx={context([HUMAN])} />);
    const bubble = view.find('[data-message-id="human-1"]')!;
    const head = bubble.querySelector('[data-testid="bubble-head"]')!;
    const shield = shieldIn(head)!;

    expect(shield).not.toBeNull();
    expect(shield.getAttribute('aria-label')).toContain('Security:');
    // After the time, not before it: the mark qualifies the header, it does
    // not interrupt it.
    expect(
      bubble.querySelector('[data-testid="bubble-time"]')!.compareDocumentPosition(shield) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    view.unmount();
  });

  // Regression: both halves of the old footer row come back — the shield a
  // second time, and the sender's address under a header that already names
  // the sender (and gives the full From/To/Cc on hover).
  it('leaves no shield and no repeated address under the body', () => {
    const view = render(<ThreadChatView ctx={context([HUMAN])} />);
    const footer = view.find('[data-testid="bubble-footer"]')!;

    expect(shieldIn(footer)).toBeNull();
    expect(footer.textContent).not.toContain('alice@acme.example');
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
