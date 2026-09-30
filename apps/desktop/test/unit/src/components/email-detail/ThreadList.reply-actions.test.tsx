// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toForwardSource } from '../../../../../src/utils/forward-quote';
import { render, toggle, type Mounted } from '../../../../helpers/render';

import { ELEVEN_AM, email, TEN_AM } from './email-fixture';

/**
 * The reply row under each expanded reply in the standard (list) view, and the
 * forward box it opens there.
 *
 * What breaks if this file goes red: the row, now shared with the anchor card
 * and the chat, answers the wrong way from a reply — Forward jumping to the
 * popup composer instead of opening under the message, or a button reaching
 * the wrong handler — or a forward reopened by Undo send comes back empty.
 */

// Children this component merely composes; the real ones build iframes and
// reach for IPC. Same stand-ins as ThreadList.test.tsx.
vi.mock('../../../../../src/components/SandboxedEmailBody', () => ({
  SandboxedEmailBody: (props: { html: string }) => <div data-testid="body">{props.html}</div>,
}));
/** Each message's three-dot menu props, as the list last drew them. */
const menuProps = new Map<string, Record<string, () => void>>();
vi.mock('../../../../../src/components/email-detail/EmailMenu', () => ({
  EmailMenu: (props: { email: { id: string } } & Record<string, () => void>) => {
    menuProps.set(props.email.id, props);
    return <div data-testid="menu" />;
  },
}));
vi.mock('../../../../../src/components/email-detail/EmailHeaderDetails', () => ({
  EmailHeaderDetails: () => <div data-testid="headers" />,
}));
const replyProps: { current?: Record<string, unknown> } = {};
vi.mock('../../../../../src/components/InlineReply', () => ({
  InlineReply: (props: Record<string, unknown>) => {
    replyProps.current = props;
    return <div data-testid="inline-reply" />;
  },
}));
const forwardProps: { current?: Record<string, unknown> } = {};
vi.mock('../../../../../src/components/InlineForward', () => ({
  InlineForward: (props: Record<string, unknown>) => {
    forwardProps.current = props;
    return <div data-testid="inline-forward" />;
  },
}));
vi.mock('../../../../../src/services/ai-service', () => ({
  isSignatureDetectionEnabled: () => false,
}));
vi.mock('../../../../../src/utils/sender-identity', () => ({
  useSenderIdentity: () => null,
}));
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: Object.assign(() => undefined, { getState: () => ({ clearSelectedEmail: vi.fn() }) }),
}));

const { ThreadList } = await import('../../../../../src/components/email-detail/ThreadList');

const ANCHOR = email({ id: 'anchor', date: TEN_AM, rawBody: '<p>Kicking this off.</p>' });
const REPLY = email({
  id: 'reply',
  date: ELEVEN_AM,
  fromName: 'Bob Ray',
  fromAddress: 'bob@acme.example',
  rawBody: '<p>Looks good.</p>',
  hasAttachments: true,
  attachmentNames: 'plan.pdf',
  attachmentSizes: '[1024]',
} as Partial<EmailRecord> & { id: string });

type Handlers = Record<
  'handleReply' | 'handleReplyAll' | 'handleInlineForward' | 'handleForward' | 'toggleThread',
  ReturnType<typeof vi.fn>
>;
const newHandlers = (): Handlers => ({
  handleReply: vi.fn(),
  handleReplyAll: vi.fn(),
  handleInlineForward: vi.fn(),
  handleForward: vi.fn(),
  toggleThread: vi.fn(),
});

/** A ThreadList context with REPLY expanded; every flag it reads spelled out. */
const context = (handlers: Handlers, overrides: Record<string, unknown> = {}) =>
  new Proxy(
    {
      displayEmail: ANCHOR,
      threadEmails: [ANCHOR, REPLY],
      duplicatesByEmailId: new Map<string, unknown[]>(),
      polishThreadContext: '',
      expandedThreads: new Set(['reply']),
      showFullContent: new Set<string>(),
      showSignatures: new Set<string>(),
      loadingBodies: new Set<string>(),
      showInlineReply: false,
      replyingToEmail: null,
      inlineReplyDraft: undefined,
      inlineReplyMode: 'reply',
      showInlineForward: false,
      forwardingEmail: null,
      inlineForwardDraft: undefined,
      ...handlers,
      ...overrides,
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : vi.fn()) },
  ) as never;

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  forwardProps.current = undefined;
  replyProps.current = undefined;
  menuProps.clear();
});

const row = (view: Mounted) => view.byLabel('Reply actions');
const rowButton = (view: Mounted, text: string) =>
  [...(row(view)?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text) ?? null;

describe('ThreadList — the reply row under a reply', () => {
  // Regression guard for the shared row: from a reply, each button answers
  // THAT reply, and Forward opens inline under it — never the popup.
  it('answers the reply it sits under, forwarding inline', () => {
    const h = newHandlers();
    mounted = render(<ThreadList ctx={context(h)} />);

    toggle(rowButton(mounted, 'Reply'));
    toggle(rowButton(mounted, 'Reply All'));
    toggle(rowButton(mounted, 'Forward'));

    // `false`: not the popup — the default, now spelled out by the shared
    // builder the reply's row and its menu both use.
    expect(h.handleReply.mock.calls).toEqual([[REPLY, false]]);
    expect(h.handleReplyAll.mock.calls).toEqual([[REPLY, false]]);
    expect(h.handleInlineForward.mock.calls).toEqual([[REPLY]]);
    expect(h.handleForward).not.toHaveBeenCalled();
    // The click stays with the button; the card does not toggle under it.
    expect(h.toggleThread).not.toHaveBeenCalled();
  });

  // Unchanged behaviour, pinned: the row hides while a reply to this message is
  // open under it, the composer taking its place.
  it('hides while a reply to this message is open', () => {
    mounted = render(<ThreadList ctx={context(newHandlers(), { showInlineReply: true, replyingToEmail: REPLY })} />);
    expect(mounted.find('[data-testid="inline-reply"]')).not.toBeNull();
    expect(row(mounted)).toBeNull();
  });

  // Reply polish reads ONE transcript, built once in useEmailDetail from the
  // conversation's messages — the list's composer used to build its own from
  // the raw rows (drafts' neighbours, quoted history and all).
  it('hands its reply composer the thread transcript from the context', () => {
    mounted = render(
      <ThreadList
        ctx={context(newHandlers(), { showInlineReply: true, replyingToEmail: REPLY, polishThreadContext: '[Bob Ray] Mar 3, 2026: Looks good.' })}
      />,
    );
    expect(replyProps.current!.threadContext).toBe('[Bob Ray] Mar 3, 2026: Looks good.');
  });

  // No transcript (nothing usable): the composer gets none, and falls back to
  // its own single-email trail.
  it('hands no transcript when there is none', () => {
    mounted = render(<ThreadList ctx={context(newHandlers(), { showInlineReply: true, replyingToEmail: REPLY })} />);
    expect(replyProps.current!.threadContext).toBeUndefined();
  });

  // Regression: the forward box under a reply got no draft, so a forward
  // reopened by Undo send came back empty.
  it('opens the forward from the mapped source, with the restored draft', () => {
    const draft = { to: 'carol@acme.example', cc: '', htmlContent: '<p>FYI</p>', attachments: [] };
    mounted = render(
      <ThreadList
        ctx={context(newHandlers(), { showInlineForward: true, forwardingEmail: REPLY, inlineForwardDraft: draft })}
      />,
    );
    expect(forwardProps.current!.forwardEmail).toEqual(toForwardSource(REPLY));
    expect(forwardProps.current!.draft).toBe(draft);
  });
});

describe('ThreadList — the three-dot menu on a reply', () => {
  // Regression guard for the shared menu wiring: a reply's menu forwards in
  // the popup composer, as it always has here, and Delete / Archive remove
  // THIS reply — not the conversation, which is what the anchor's menu does.
  it('forwards in the popup and removes only this reply', () => {
    const h = newHandlers();
    const removal = { deleteEmail: vi.fn(), archiveEmail: vi.fn(), handleDelete: vi.fn(), handleArchive: vi.fn() };
    mounted = render(<ThreadList ctx={context(h, removal)} />);
    const menu = menuProps.get('reply')!;

    menu.onReply();
    menu.onForward();
    menu.onDelete();
    menu.onArchive();

    expect(h.handleReply.mock.calls).toEqual([[REPLY, false]]);
    expect(h.handleForward.mock.calls).toEqual([[REPLY]]);
    expect(h.handleInlineForward).not.toHaveBeenCalled();
    expect(removal.deleteEmail.mock.calls).toEqual([['reply']]);
    expect(removal.archiveEmail.mock.calls).toEqual([['reply']]);
    expect(removal.handleDelete).not.toHaveBeenCalled();
    expect(removal.handleArchive).not.toHaveBeenCalled();
  });
});
