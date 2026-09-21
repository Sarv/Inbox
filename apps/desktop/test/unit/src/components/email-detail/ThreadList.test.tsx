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
// The identity cache asks the main process over IPC; there is none here.
// Alice's domain publishes a BIMI logo, Bob's publishes nothing.
vi.mock('../../../../../src/utils/sender-identity', () => ({
  useSenderIdentity: (address: string | null | undefined) =>
    address === 'alice@acme.example'
      ? { bimi: { status: 'logo', logo: 'data:image/svg+xml;base64,PHN2Zy8+' } }
      : null,
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

/** A reply whose name and address agree — nothing to say about it. */
const CLEAN = email({
  id: 'clean',
  date: ELEVEN_AM + 3600,
  fromName: 'Bob Ray',
  fromAddress: 'bob@acme.example',
  rawBody: '<p>Looks good.</p>',
  contentType: 'html',
});

describe('ThreadList — the per-message shield', () => {
  const levelOf = (view: { find: (selector: string) => HTMLElement | null }, id: string) =>
    view.find(`#thread-${id} [data-security-level]`)?.getAttribute('data-security-level') ?? null;

  // Regression: the shield used to render only on the anchor card, so a thread
  // showed exactly ONE verdict — the oldest message's — and every reply below
  // it was silent. The banner is once per thread on purpose; the shield is not
  // a warning but a per-message level, and a reader scanning a long thread has
  // no other way to see that reply 14 came from somewhere else.
  it('renders a shield on every reply row, collapsed included', () => {
    const view = render(<ThreadList ctx={context([ANCHOR, SPOOFED, CLEAN], [])} />);
    expect(view.all('[data-security-level]')).toHaveLength(2);
    view.unmount();
  });

  // Regression: a collapsed reply has no body yet, and the link checks then
  // read an empty string and reported "no deceptive links" — which handed the
  // message `verified`, the TOP level, for a body nobody had downloaded. The
  // reader saw a green shield on unread mail and, sometimes, an amber one a
  // second later. A spinner that resolves is honest; a green shield that is
  // taken back has already been believed.
  it('spins rather than scoring a reply whose body has not arrived', () => {
    const unfetched = email({ id: 'unfetched', date: ELEVEN_AM, rawBody: '', cleanBody: '' });
    const view = render(<ThreadList ctx={context([ANCHOR, unfetched], [])} />);
    expect(view.find('#thread-unfetched [data-security-pending]')).not.toBeNull();
    expect(levelOf(view, 'unfetched')).toBeNull();
    view.unmount();
  });

  // THE thing the spinner must not swallow. Authentication and the spam score
  // come from the headers, which arrived with the message — the warning is
  // final before the first byte of the body, and withholding it until a body
  // downloads is withholding it at the only moment it matters.
  it('shows the warning on an unfetched reply the headers already condemn', () => {
    const unfetchedSpoof = email({
      id: 'unfetched',
      date: ELEVEN_AM,
      fromName: 'Sarv.com',
      fromAddress: 'no-reply@kekamail.com',
      rawBody: '',
      cleanBody: '',
    });
    const view = render(<ThreadList ctx={context([ANCHOR, unfetchedSpoof], [])} />);
    expect(['caution', 'danger']).toContain(levelOf(view, 'unfetched'));
    expect(view.find('#thread-unfetched [data-security-pending]')).toBeNull();
    view.unmount();
  });

  // The whole point of a per-message shield: the two replies are assessed
  // separately, so the spoof cannot hide behind the clean mail beside it.
  it('gives each reply its own level rather than the thread\'s', () => {
    const view = render(<ThreadList ctx={context([ANCHOR, SPOOFED, CLEAN], [])} />);
    expect(['caution', 'danger']).toContain(levelOf(view, 'reply'));
    // Asserted present as well as unalarmed — a missing shield would satisfy
    // the line below on its own, and that is the bug this file exists for.
    expect(levelOf(view, 'clean')).not.toBeNull();
    expect(['caution', 'danger']).not.toContain(levelOf(view, 'clean'));
    view.unmount();
  });
});

describe('ThreadList — the sender avatar', () => {
  const DMARC_PASS = '{"spf":"pass","dkim":"pass","dmarc":"pass","overall":"pass"}';

  // Regression: this row hand-rolled its own initials circle while the anchor
  // card used SenderAvatar, so the SAME SENDER showed a brand logo at the top
  // of a thread and two grey letters three messages down. A reader cannot
  // tell that difference from a fact about the mail.
  it('draws the brand logo on a reply, the way the anchor card does', () => {
    const withLogo = email({
      id: 'reply',
      date: ELEVEN_AM,
      fromName: 'Alice Chen',
      fromAddress: 'alice@acme.example',
      authStatus: DMARC_PASS,
      rawBody: '<p>Following up.</p>',
      contentType: 'html',
    });
    const view = render(<ThreadList ctx={context([ANCHOR, withLogo], [])} />);
    expect(view.find('[data-avatar-source="bimi"]')).not.toBeNull();
    view.unmount();
  });

  // The fallback is the same one it always had — a logo nobody publishes must
  // not turn into a blank circle.
  it('falls back to initials for a domain with no logo', () => {
    const plain = email({
      id: 'reply',
      date: ELEVEN_AM,
      fromName: 'Bob Ray',
      fromAddress: 'bob@acme.example',
      rawBody: '<p>Looks good.</p>',
      contentType: 'html',
    });
    const view = render(<ThreadList ctx={context([plain], [])} />);
    const avatar = view.find('[data-avatar-source="initials"]')!;
    expect(avatar).not.toBeNull();
    expect(avatar.textContent).toContain('BR');
    view.unmount();
  });
});
