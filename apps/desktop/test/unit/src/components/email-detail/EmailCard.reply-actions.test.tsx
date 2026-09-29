// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { render, toggle, type Mounted } from '../../../../helpers/render';

import { email, TEN_AM } from './email-fixture';

/**
 * The reply row in the anchor card's footer (the thread's first message, in the
 * standard view).
 *
 * What breaks if this file goes red: the row, now one component shared with the
 * replies and the chat, changes what the anchor card's buttons do. Its Forward
 * opens the POPUP composer — unlike Forward under a reply, which opens inline —
 * and a shared row that quietly picked one behaviour for everybody would change
 * this card's without anyone deciding it.
 */

// Children the card merely composes; the real ones build iframes, reach for IPC
// or query the main process.
vi.mock('../../../../../src/components/SandboxedEmailBody', () => ({
  SandboxedEmailBody: (props: { html: string }) => <div data-testid="body">{props.html}</div>,
}));
/** The card's three-dot menu props, as it last drew them. */
const menuProps: { current?: Record<string, () => void> } = {};
vi.mock('../../../../../src/components/email-detail/EmailMenu', () => ({
  EmailMenu: (props: Record<string, () => void>) => {
    menuProps.current = props;
    return <div data-testid="menu" />;
  },
}));
vi.mock('../../../../../src/components/email-detail/EmailHeaderDetails', () => ({
  EmailHeaderDetails: () => <div data-testid="headers" />,
}));
vi.mock('../../../../../src/components/email-detail/CalendarInviteBanner', () => ({
  CalendarInviteBanner: () => null,
}));
vi.mock('../../../../../src/components/email-detail/UnsubscribeButton', () => ({
  UnsubscribeButton: () => null,
}));
vi.mock('../../../../../src/services/ai-service', () => ({
  isSignatureDetectionEnabled: () => false,
}));
vi.mock('../../../../../src/utils/sender-identity', () => ({
  useSenderIdentity: () => null,
}));
vi.mock('../../../../../src/store/helpers', () => ({
  qualifiesForSafeAutoLoad: () => false,
}));
const storeState = { fetchEmailBody: vi.fn(), clearSelectedEmail: vi.fn() };
vi.mock('../../../../../src/store/email-store', () => ({
  // The card reads the store both ways: whole (`useEmailStore()`) and via getState.
  useEmailStore: Object.assign(
    (select?: (state: typeof storeState) => unknown) => (select ? select(storeState) : storeState),
    { getState: () => storeState, setState: vi.fn() },
  ),
}));

const { EmailCard } = await import('../../../../../src/components/email-detail/EmailCard');

const ANCHOR = email({
  id: 'anchor',
  date: TEN_AM,
  rawBody: '<p>Kicking this off.</p>',
  cleanBody: 'Kicking this off.',
});

type Handlers = Record<'handleReply' | 'handleReplyAll' | 'handleForward' | 'handleInlineForward', ReturnType<typeof vi.fn>>;
const newHandlers = (): Handlers => ({
  handleReply: vi.fn(),
  handleReplyAll: vi.fn(),
  handleForward: vi.fn(),
  handleInlineForward: vi.fn(),
});

/** An expanded anchor card's context; every flag it reads spelled out. */
const context = (handlers: Handlers, overrides: Record<string, unknown> = {}) =>
  new Proxy(
    {
      displayEmail: ANCHOR,
      duplicatesByEmailId: new Map<string, unknown[]>(),
      isStarred: false,
      attachments: [],
      mainEmailExpanded: true,
      showFullHeaders: false,
      showSignatures: new Set<string>(),
      showInlineReply: false,
      replyingToEmail: null,
      chatViewActive: false,
      loadingBodies: new Set<string>(),
      failedBodies: new Set<string>(),
      ...handlers,
      ...overrides,
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : vi.fn()) },
  ) as never;

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  menuProps.current = undefined;
});

const row = (view: Mounted) => view.byLabel('Reply actions');
const rowButton = (view: Mounted, text: string) =>
  [...(row(view)?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text) ?? null;

describe('EmailCard — the reply row in the footer', () => {
  // Regression guard: Reply and Reply All answer the anchor inline, and
  // Forward stays the popup it has always been here.
  it('replies inline to the anchor and forwards it in the popup composer', () => {
    const h = newHandlers();
    mounted = render(<EmailCard ctx={context(h)} />);

    toggle(rowButton(mounted, 'Reply'));
    toggle(rowButton(mounted, 'Reply All'));
    toggle(rowButton(mounted, 'Forward'));

    // `false`: not the popup — the default, now spelled out by the shared
    // builder the anchor card's row and its menu both use.
    expect(h.handleReply.mock.calls).toEqual([[ANCHOR, false]]);
    expect(h.handleReplyAll.mock.calls).toEqual([[ANCHOR, false]]);
    expect(h.handleForward.mock.calls).toEqual([[ANCHOR]]);
    expect(h.handleInlineForward).not.toHaveBeenCalled();
  });

  // Unchanged behaviour, pinned: the row gives way to the composer it opened.
  it('hides while a reply to the anchor is open', () => {
    mounted = render(
      <EmailCard ctx={context(newHandlers(), { showInlineReply: true, replyingToEmail: ANCHOR })} />,
    );
    expect(row(mounted)).toBeNull();
  });

  // A reply open on ANOTHER message leaves this card's row where it is.
  it('stays while a reply to another message is open', () => {
    mounted = render(
      <EmailCard
        ctx={context(newHandlers(), { showInlineReply: true, replyingToEmail: { id: 'other' } })}
      />,
    );
    expect(row(mounted)).not.toBeNull();
  });
});

describe('EmailCard — the three-dot menu', () => {
  // Regression guard for the shared menu wiring: the anchor card stands for
  // the conversation. Its menu forwards in the popup, and Delete / Archive take
  // the whole thread — as they did before the wiring was shared.
  it('forwards in the popup and removes the whole conversation', () => {
    const h = newHandlers();
    const removal = { deleteEmail: vi.fn(), archiveEmail: vi.fn(), handleDelete: vi.fn(), handleArchive: vi.fn() };
    mounted = render(<EmailCard ctx={context(h, removal)} />);
    const menu = menuProps.current!;

    menu.onForward();
    menu.onDelete();
    menu.onArchive();

    expect(h.handleForward.mock.calls).toEqual([[ANCHOR]]);
    expect(h.handleInlineForward).not.toHaveBeenCalled();
    expect(removal.handleDelete).toHaveBeenCalledTimes(1);
    expect(removal.handleArchive).toHaveBeenCalledTimes(1);
    expect(removal.deleteEmail).not.toHaveBeenCalled();
    expect(removal.archiveEmail).not.toHaveBeenCalled();
  });
});
