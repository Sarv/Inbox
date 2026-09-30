// @vitest-environment happy-dom
import type { MessageMenuRequest } from '@sarv-in/email-chat-view';
import type { EmailRecord } from '@sarvinbox/core';
import { setLogSink } from '@sarvinbox/core/logger';
import { format } from 'date-fns';
import { useEffect, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, render, settle, toggle, type Mounted } from '../../../../helpers/render';

import { chatFieldsFor } from './chat-context-fixture';
import { ELEVEN_AM, email, TEN_AM } from './email-fixture';

/**
 * The chat's right-click menu: a right-click anywhere in a bubble opens the
 * same menu as the bubble's three-dot button, at the pointer, for that bubble's
 * message.
 *
 * What breaks if this file goes red: a right-click acts on the wrong message
 * (the mail that QUOTED a bubble, say, addressed to someone else), offers a
 * menu different from the bubble's own, disappears when the theme changes,
 * lingers after its message was deleted — or leaves the reader, in an app with
 * no native context menu, unable to copy what they selected.
 */

/** What the chat library was last handed, and how often it mounted. */
const view$ = {
  messages: [] as readonly { id: string }[],
  onMessageMenu: undefined as
    | ((message: { id: string }, request: MessageMenuRequest) => boolean | void)
    | undefined,
  onOpenLink: undefined as ((url: string) => void) | undefined,
  mounts: 0,
};

// A stand-in for the chat library: its bubbles, the per-bubble actions slot
// (where the three-dot menu lives), and the one thing this file drives — the
// right-click callback, which the real view calls with the page point, the
// link under the pointer and the selection inside the message.
vi.mock('@sarv-in/email-chat-view', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MailChatView: ({
    messages,
    onMessageMenu,
    onOpenLink,
    renderActions,
  }: {
    messages: readonly { id: string }[];
    onMessageMenu?: typeof view$.onMessageMenu;
    onOpenLink?: (url: string) => void;
    renderActions?: (message: { id: string }) => ReactNode;
  }) => {
    view$.messages = messages;
    view$.onMessageMenu = onMessageMenu;
    view$.onOpenLink = onOpenLink;
    useEffect(() => {
      view$.mounts += 1;
    }, []);
    return (
      <div data-testid="chat-view">
        {messages.map((message) => (
          <div key={message.id} data-testid="bubble" data-message-id={message.id}>
            <div className="sec-actions">{renderActions?.(message)}</div>
          </div>
        ))}
      </div>
    );
  },
}));

/** The app theme, as the appearance hooks report it. Flipping it remounts the view. */
const theme = { resolved: 'light' as 'light' | 'dark' };
vi.mock('../../../../../src/appearance', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAppearance: () => ({ darkenEmails: false }),
  useResolvedTheme: () => theme.resolved,
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
  getCurrentUserEmail: () => 'me@acme.example',
}));
vi.mock('../../../../../src/services/image-cache', () => ({
  resolveRefsInHtml: (html: string) => html,
}));
// The remote-image decision (and its trust caches) is its own suite's
// business (remote-images.test.ts, ThreadChatView.remote-images.test.tsx):
// here every bubble simply blocks, with no IPC behind it.
vi.mock('../../../../../src/utils/remote-images', () => ({
  remoteImageFactsOf: (email: unknown) => email,
  shouldAutoLoadRemoteImages: () => false,
  useImageTrustSelector: <T,>(select: () => T) => select(),
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

const OPENER = email({
  id: 'opener',
  date: TEN_AM,
  fromName: 'Alice Chen',
  fromAddress: 'alice@acme.example',
  rawBody: '<p>Kicking this off.</p>',
});

const ANSWER = email({
  id: 'answer',
  date: ELEVEN_AM,
  fromName: 'Bob Ray',
  fromAddress: 'bob@acme.example',
  rawBody: '<p>On it.</p>',
});

/** Bob's reply, quoting Alice: two bubbles, and only Bob's is a mail of its own. */
const CARRIER = email({
  id: 'carrier',
  date: ELEVEN_AM,
  fromName: 'Bob Ray',
  fromAddress: 'bob@acme.example',
  rawBody: [
    '<div dir="ltr">Attached, as promised.</div>',
    '<div class="gmail_quote">',
    '<div dir="ltr" class="gmail_attr">',
    'On Tue, 3 Mar 2026 at 10:00, Alice Chen &lt;alice@acme.example&gt; wrote:<br>',
    '</div>',
    '<blockquote class="gmail_quote"><div dir="ltr">Could you send over the',
    ' signed copy before Friday? Legal need it for the review.</div></blockquote>',
    '</div>',
  ].join(''),
});

const HANDLER_NAMES = [
  'handleReply', 'handleReplyAll', 'handleForward', 'handleInlineForward',
  'handleDelete', 'handleArchive', 'deleteEmail', 'archiveEmail',
] as const;
type Handlers = Record<(typeof HANDLER_NAMES)[number], ReturnType<typeof vi.fn>>;
const newHandlers = () =>
  Object.fromEntries(HANDLER_NAMES.map((name) => [name, vi.fn()])) as Handlers;

/** A ThreadChatView context; every flag it reads spelled out (the Proxy's
 *  fallback is a `vi.fn()`, and a function is truthy). */
const context = (threadEmails: EmailRecord[], handlers: Handlers = newHandlers()) =>
  new Proxy(
    {
      displayEmail: threadEmails[0],
      threadEmails,
      // Standard's turns, split the way useEmailDetail splits them.
      ...chatFieldsFor(threadEmails),
      showAIView: false,
      chatViewActive: true,
      showInlineReply: false,
      showInlineForward: false,
      replyingToEmail: null,
      forwardingEmail: null,
      inlineReplyDraft: undefined,
      inlineForwardDraft: undefined,
      inlineReplyMode: 'reply',
      ...handlers,
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : vi.fn()) },
  ) as never;

const mounted: Mounted[] = [];
const mount = (element: Parameters<typeof render>[0]) => {
  const view = render(element);
  mounted.push(view);
  return view;
};

const writeText = vi.fn(async (_text: string) => {});
const openExternal = vi.fn();
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  (window as unknown as { electronAPI: unknown }).electronAPI = { app: { openExternal } };
});
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount());
  view$.messages = [];
  view$.onMessageMenu = undefined;
  view$.onOpenLink = undefined;
  view$.mounts = 0;
  theme.resolved = 'light';
  writeText.mockReset();
  writeText.mockImplementation(async () => {});
  openExternal.mockReset();
  setLogSink(null);
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

/** Right-click the bubble for `messageId` — what the library reports. */
const rightClick = (messageId: string, request: Partial<MessageMenuRequest> = {}) => {
  const message = view$.messages.find((m) => m.id === messageId);
  if (!message) throw new Error(`no bubble ${messageId}`);
  let answer: boolean | void = undefined;
  act(() => {
    answer = view$.onMessageMenu!(message, {
      clientX: 140,
      clientY: 200,
      href: null,
      selectionText: '',
      ...request,
    });
  });
  return answer;
};

const menus = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')];
const itemLabels = (menu: HTMLElement) =>
  [...menu.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
const choose = (label: string) =>
  toggle([...document.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === label) ?? null);
const nameOf = (mail: EmailRecord) =>
  `${mail.fromName}, ${format(new Date(mail.date * 1000), 'MMM d, h:mm a')}`;

describe('ThreadChatView — the right-click menu', () => {
  // The feature: a right-click on a bubble opens its message's menu with the
  // menu's corner on the pointer, and tells the library it took the click.
  it('opens the message menu at the pointer', () => {
    mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    expect(rightClick('answer', { clientX: 140, clientY: 200 })).not.toBe(false);

    const [menu] = menus();
    expect(menus()).toHaveLength(1);
    expect(menu!.style.left).toBe('140px');
    expect(menu!.style.top).toBe('200px');
    // Named for its message, like the bubble's own action cluster.
    expect(menu!.getAttribute('aria-label')).toBe(`Message actions for ${nameOf(ANSWER)}`);
  });

  // Regression guard: a bubble recovered from a quote has no mail of its own;
  // acting on "it" would act on the mail that quoted it. It gets no menu (it
  // has no three-dot button either), and the library is told so — it then
  // leaves the right-click to the browser.
  it('declines on a bubble recovered from a quote', () => {
    mount(<ThreadChatView ctx={context([CARRIER])} />);
    const recovered = view$.messages.find((m) => m.id !== 'carrier')!;
    expect(rightClick(recovered.id)).toBe(false);
    expect(menus()).toHaveLength(0);

    expect(rightClick('carrier')).not.toBe(false);
    expect(menus()).toHaveLength(1);
  });

  // The items act on the RIGHT-CLICKED message, the chat's way: Forward inline
  // (the chat has its own composer), Delete this message — never the thread.
  it('acts on the right-clicked message, the chat\'s way', () => {
    const h = newHandlers();
    mount(<ThreadChatView ctx={context([OPENER, ANSWER], h)} />);

    rightClick('opener');
    choose('Reply');
    rightClick('opener');
    choose('Forward');
    rightClick('opener');
    choose('Delete');

    expect(h.handleReply.mock.calls).toEqual([[OPENER, false]]);
    expect(h.handleInlineForward.mock.calls).toEqual([[OPENER]]);
    expect(h.handleForward).not.toHaveBeenCalled();
    expect(h.deleteEmail.mock.calls).toEqual([['opener']]);
    expect(h.handleDelete).not.toHaveBeenCalled();
    // Choosing closes it.
    expect(menus()).toHaveLength(0);
  });

  // Regression guard for "the same menu": the right-click menu and the
  // bubble's three-dot menu list the same items and do the same thing.
  it('is the same menu as the bubble\'s three-dot button', () => {
    const viaButton = newHandlers();
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], viaButton)} />);
    const bubble = view.find('[data-message-id="answer"]')!;
    toggle(bubble.querySelector('[aria-label="More actions"]'));
    const buttonItems = itemLabels(menus()[0]!);
    choose('Reply all');
    view.unmount();
    mounted.splice(0);

    const viaRightClick = newHandlers();
    mount(<ThreadChatView ctx={context([OPENER, ANSWER], viaRightClick)} />);
    rightClick('answer');
    expect(itemLabels(menus()[0]!)).toEqual(buttonItems);
    choose('Reply all');

    expect(viaRightClick.handleReplyAll.mock.calls).toEqual(viaButton.handleReplyAll.mock.calls);
    expect(viaRightClick.handleReplyAll.mock.calls).toEqual([[ANSWER, false]]);
  });

  // ONE menu per thread: a right-click on another bubble moves it there, for
  // that bubble's message.
  it('moves to the next bubble right-clicked', () => {
    const h = newHandlers();
    mount(<ThreadChatView ctx={context([OPENER, ANSWER], h)} />);
    rightClick('opener', { clientX: 50, clientY: 60 });
    rightClick('answer', { clientX: 300, clientY: 320 });

    expect(menus()).toHaveLength(1);
    expect(menus()[0]!.style.left).toBe('300px');
    expect(menus()[0]!.getAttribute('aria-label')).toBe(`Message actions for ${nameOf(ANSWER)}`);
    choose('Reply');
    expect(h.handleReply.mock.calls).toEqual([[ANSWER, false]]);
  });

  // Regression guard: the library REMOUNTS on a theme change (see the `key` on
  // MailChatView). The menu lives outside it, so a theme flip mid-use leaves
  // the open menu where it is.
  it('stays open across the view\'s remount on a theme change', () => {
    const ctx = context([OPENER, ANSWER]);
    const view = mount(<ThreadChatView ctx={ctx} />);
    rightClick('answer');
    const menu = menus()[0];
    const mountsBefore = view$.mounts;

    theme.resolved = 'dark';
    view.rerender(<ThreadChatView ctx={context([OPENER, ANSWER])} />);

    expect(view$.mounts).toBe(mountsBefore + 1);
    expect(menus()).toHaveLength(1);
    // The very same element: not closed and redrawn, never unmounted.
    expect(menus()[0]).toBe(menu);
  });

  // It closes when its message leaves the thread (deleted, moved) — and stays
  // closed if a reload brings the message back, rather than springing open.
  it('closes for good when its message leaves the thread', () => {
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    rightClick('answer');

    view.rerender(<ThreadChatView ctx={context([OPENER])} />);
    expect(menus()).toHaveLength(0);

    view.rerender(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    expect(menus()).toHaveLength(0);
  });

  // A message that stays keeps its menu open through an unrelated re-render.
  it('stays open while its message stays in the thread', () => {
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    rightClick('answer');
    view.rerender(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    expect(menus()).toHaveLength(1);
  });

  // Escape closes it — and must not ALSO reach the app's global Escape, which
  // would deselect the email and close the thread under the reader.
  it('closes on Escape without closing the thread', () => {
    mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    rightClick('answer');
    const globalShortcut = vi.fn();
    document.addEventListener('keydown', globalShortcut);

    act(() => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });

    expect(menus()).toHaveLength(0);
    expect(globalShortcut).not.toHaveBeenCalled();
    document.removeEventListener('keydown', globalShortcut);
  });
});

describe('ThreadChatView — the right-click menu\'s Copy and link items', () => {
  // A plain right-click: just the message's items — no Copy with nothing to
  // copy, no link items with no link.
  it('adds nothing on plain text', () => {
    mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    rightClick('answer');
    expect(itemLabels(menus()[0]!)[0]).toBe('Reply');
    expect(itemLabels(menus()[0]!)).not.toContain('Copy');
    expect(itemLabels(menus()[0]!)).not.toContain('Open link');
  });

  // THE regression Copy exists for: the app has no native context menu, so a
  // right-click menu without Copy leaves no way to copy a selection by mouse.
  it('offers Copy for a selection, and copies exactly it', async () => {
    mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    rightClick('answer', { selectionText: 'On it.' });
    expect(itemLabels(menus()[0]!).slice(0, 2)).toEqual(['Copy', 'Reply']);

    choose('Copy');
    await settle();
    expect(writeText.mock.calls).toEqual([['On it.']]);
    expect(menus()).toHaveLength(0);
  });

  // Over a link: open it through the app's external-open path, or copy it.
  it('offers Open link and Copy link over a link', async () => {
    mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    rightClick('answer', { href: 'https://example.test/plan' });
    expect(itemLabels(menus()[0]!).slice(0, 3)).toEqual(['Open link', 'Copy link', 'Reply']);
    choose('Open link');
    expect(openExternal.mock.calls).toEqual([['https://example.test/plan']]);

    rightClick('answer', { href: 'https://example.test/plan' });
    choose('Copy link');
    await settle();
    expect(writeText.mock.calls).toEqual([['https://example.test/plan']]);
  });

  // Failure path: the clipboard refuses (the window lost focus, no secure
  // context). The click must not throw out of the menu, the menu still closes
  // — and the failure is NOT swallowed: with no button left to say "Copy
  // failed" on, it goes to the log, where a "copy did nothing" report can be
  // traced.
  it('survives a clipboard that refuses, and logs it', async () => {
    writeText.mockRejectedValue(new Error('Document is not focused'));
    const sink = vi.fn();
    setLogSink(sink);
    mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    rightClick('answer', { selectionText: 'On it.' });

    choose('Copy');
    await settle();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(menus()).toHaveLength(0);
    expect(sink.mock.calls.filter(([level, name]) => level === 'warn' && name === 'ThreadChatView'))
      .toHaveLength(1);
  });

  // ...and a copy that worked logs nothing: a warning on every copy would
  // bury the ones that matter.
  it('logs nothing for a copy that worked', async () => {
    const sink = vi.fn();
    setLogSink(sink);
    mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    rightClick('answer', { href: 'https://example.test/plan' });

    choose('Copy link');
    await settle();

    expect(writeText.mock.calls).toEqual([['https://example.test/plan']]);
    expect(sink.mock.calls.filter(([, name]) => name === 'ThreadChatView')).toEqual([]);
  });

  // "Open link" goes the way a link click in a body goes — outside Electron
  // (the web build, a test page), a new browser tab.
  it('opens the link in a new tab outside Electron', () => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    rightClick('answer', { href: 'https://example.test/plan' });

    choose('Open link');

    expect(open.mock.calls).toEqual([['https://example.test/plan', '_blank']]);
    open.mockRestore();
  });
});

describe('ThreadChatView — link clicks, the path "Open link" shares', () => {
  // The rule "Open link" and a plain link click share with the standard view
  // (utils/open-external). Regression: the chat's lower-case check sent a
  // sender's MAILTO: link to the browser path that mailto: never takes — the
  // chat opens no mailto: link, in either case.
  it.each(['MAILTO:bob@acme.example', 'mailto:bob@acme.example', '#section-2'])(
    'opens nothing for %s',
    (url) => {
      mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
      act(() => view$.onOpenLink!(url));
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  it('opens a web link through the app', () => {
    mount(<ThreadChatView ctx={context([OPENER, ANSWER])} />);
    act(() => view$.onOpenLink!('https://example.test/plan'));
    expect(openExternal.mock.calls).toEqual([['https://example.test/plan']]);
  });
});
