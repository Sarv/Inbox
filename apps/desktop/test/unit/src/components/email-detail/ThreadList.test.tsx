// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../../../../helpers/render';

import { ELEVEN_AM, email, TEN_AM } from './email-fixture';

/**
 * The thread's replies, in the standard (list) view.
 *
 * What breaks if this file goes red: the phishing warning goes back to being
 * rendered in exactly ONE place — EmailCard, which shows `displayEmail`, the
 * thread's OLDEST message. Every reply after it was unchecked, so a thread
 * whose first mail is genuine and whose newest is a spoof warned about nothing
 * at all. The check itself is per message and sender-based, so it always had an
 * answer here; nothing ever asked for it.
 */

// Everything below stands in for a child this component merely composes. The
// real ones build iframes, portal menus and reach for providers at import time
// — none of which decides whether a reply is checked for spoofing.
vi.mock('../../../../../src/components/SandboxedEmailBody', () => ({
  SandboxedEmailBody: (props: { html: string }) => <div data-testid="body">{props.html}</div>,
}));
vi.mock('../../../../../src/components/email-detail/EmailMenu', () => ({
  EmailMenu: () => <div data-testid="menu" />,
}));
vi.mock('../../../../../src/components/email-detail/EmailHeaderDetails', () => ({
  EmailHeaderDetails: () => <div data-testid="headers" />,
}));
vi.mock('../../../../../src/components/InlineReply', () => ({ InlineReply: () => null }));
vi.mock('../../../../../src/components/InlineForward', () => ({ InlineForward: () => null }));
vi.mock('../../../../../src/services/ai-service', () => ({
  isSignatureDetectionEnabled: () => false,
  buildPolishThreadContext: () => '',
  getCurrentUserEmail: () => 'me@acme.example',
}));
vi.mock('../../../../../src/store/helpers', () => ({
  qualifiesForSafeAutoLoad: () => false,
}));
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: Object.assign(() => undefined, { getState: () => ({ clearSelectedEmail: vi.fn() }) }),
}));

const { ThreadList } = await import('../../../../../src/components/email-detail/ThreadList');

const ANCHOR = email({
  id: 'anchor',
  date: TEN_AM,
  fromName: 'Alice Chen',
  fromAddress: 'alice@acme.example',
  rawBody: '<p>Kicking this off.</p>',
  contentType: 'html',
});

/** A reply whose display name claims one domain and whose address is another —
 *  the classic display-name spoof, and the reported Keka shape. */
const SPOOFED = email({
  id: 'reply',
  date: ELEVEN_AM,
  fromName: 'Sarv.com',
  fromAddress: 'no-reply@kekamail.com',
  rawBody: '<p>Your daily digest.</p>',
  contentType: 'html',
});

/** A ThreadList context: the fields it reads, and a stub for every handler. */
const context = (threadEmails: EmailRecord[], expanded: string[]) =>
  new Proxy(
    {
      displayEmail: ANCHOR,
      threadEmails,
      duplicatesByEmailId: new Map<string, unknown[]>(),
      conversationMessages: null,
      expandedThreads: new Set(expanded),
      showFullContent: new Set<string>(),
      showSignatures: new Set<string>(),
      loadingBodies: new Set<string>(),
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : vi.fn()) },
  ) as never;

describe('ThreadList', () => {
  // Regression: this is the message the reader is actually looking at when new
  // mail arrives — the anchor above it is collapsed — and it used to carry no
  // warning whatsoever.
  it('warns on an expanded reply, not only on the thread anchor', () => {
    const view = render(<ThreadList ctx={context([ANCHOR, SPOOFED], ['reply'])} />);
    const alert = view.find('[role="alert"]')!;
    expect(alert).not.toBeNull();
    expect(alert.textContent).toContain('kekamail.com');
    view.unmount();
  });

  // The warning must sit above the body it is about — a reader who meets it
  // after reading the message has already done the thing it warns against.
  it('renders the warning above the reply body', () => {
    const view = render(<ThreadList ctx={context([ANCHOR, SPOOFED], ['reply'])} />);
    const alert = view.find('[role="alert"]')!;
    const body = view.find('[data-testid="body"]')!;
    expect(alert.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    view.unmount();
  });

  // A banner that fires on ordinary mail is a banner people stop reading.
  it('shows nothing for a reply whose sender is consistent', () => {
    const clean = email({
      id: 'reply',
      date: ELEVEN_AM,
      fromName: 'Bob Ray',
      fromAddress: 'bob@acme.example',
      rawBody: '<p>Looks good.</p>',
      contentType: 'html',
    });
    const view = render(<ThreadList ctx={context([ANCHOR, clean], ['reply'])} />);
    expect(view.find('[role="alert"]')).toBeNull();
    view.unmount();
  });

  // The assessment is body-independent, but it is rendered with the body — a
  // collapsed reply shows only its header, and a warning there would have
  // nothing to warn about yet.
  it('does not warn on a collapsed reply', () => {
    const view = render(<ThreadList ctx={context([ANCHOR, SPOOFED], [])} />);
    expect(view.find('[role="alert"]')).toBeNull();
    view.unmount();
  });
});
