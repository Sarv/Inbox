// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import { format } from 'date-fns';
import { useEffect, useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toForwardSource } from '../../../../../src/utils/forward-quote';
import { act, render, toggle, type Mounted } from '../../../../helpers/render';

import { ELEVEN_AM, email, TEN_AM } from './email-fixture';

/**
 * Answering from the chat view: the Reply / Reply All / Forward row at the end
 * of the conversation, the same three as icons on each bubble, and the one
 * composer they all open.
 *
 * What breaks if this file goes red: a reply goes to the wrong message or the
 * wrong people. The row answers the NEWEST message (what the shortcuts and the
 * toolbar answer); an icon answers ITS bubble; and because the chat has one
 * composer for every bubble, pointing it at a second message has to start a
 * fresh one — or it keeps the first message's body, draft and attachments and
 * sends them as the reply to the second.
 */

/** Bubble ids in render order, with whether the quick-actions slot answered. */
const quickAnswers: { id: string; answered: boolean }[] = [];
/** A click that reached the bubble itself. */
const bubbleClick = vi.fn();

// A stand-in for the chat library: bubbles, the quick-actions slot the way the
// library treats it (nothing at all for a falsy answer), the empty state when
// there is nothing to show, and its auto-scroll — its own bottom scrolled into
// view whenever the last message changes, from an effect, as the library does.
vi.mock('@sarv-in/email-chat-view', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MailChatView: ({
    messages,
    renderQuickActions,
    renderActions,
    emptyState,
  }: {
    messages: readonly { id: string }[];
    renderQuickActions?: (message: { id: string }) => ReactNode;
    renderActions?: (message: { id: string }) => ReactNode;
    emptyState?: ReactNode;
  }) => {
    const bottom = useRef<HTMLDivElement>(null);
    const lastId = messages[messages.length - 1]?.id;
    useEffect(() => {
      bottom.current?.scrollIntoView?.({ block: 'end' });
    }, [lastId]);
    return (
      <div data-testid="chat-view">
        {messages.length === 0 ? emptyState : null}
        {messages.map((message) => {
          const quick = renderQuickActions?.(message);
          quickAnswers.push({ id: message.id, answered: !!quick });
          return (
            <div key={message.id} data-testid="bubble" data-message-id={message.id} onClick={bubbleClick}>
              {quick ? <div className="sec-quick">{quick}</div> : null}
              <div className="sec-actions">{renderActions?.(message)}</div>
            </div>
          );
        })}
        <div className="sec-bottom" ref={bottom} />
      </div>
    );
  },
}));

/** Every composer mount and unmount, in order, with the message it was for. */
const composerLog: string[] = [];
const composerProps: { reply?: Record<string, unknown>; forward?: Record<string, unknown> } = {};

vi.mock('../../../../../src/components/InlineReply', () => ({
  InlineReply: (props: { replyToEmail: { id: string } }) => {
    composerProps.reply = props;
    useEffect(() => {
      composerLog.push(`reply:mount:${props.replyToEmail.id}`);
      return () => void composerLog.push(`reply:unmount:${props.replyToEmail.id}`);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <div data-testid="inline-reply" />;
  },
}));
vi.mock('../../../../../src/components/InlineForward', () => ({
  InlineForward: (props: { forwardEmail: { id: string } }) => {
    composerProps.forward = props;
    useEffect(() => {
      composerLog.push(`forward:mount:${props.forwardEmail.id}`);
      return () => void composerLog.push(`forward:unmount:${props.forwardEmail.id}`);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <div data-testid="inline-forward" />;
  },
}));
/** The three-dot menu's props, per message, as the bubble last drew it. */
const menuProps = new Map<string, Record<string, () => void>>();
vi.mock('../../../../../src/components/email-detail/EmailMenu', () => ({
  EmailMenu: (props: { email: { id: string } } & Record<string, () => void>) => {
    menuProps.set(props.email.id, props);
    return <div data-testid="menu" />;
  },
}));
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
  hasAttachments: true,
  attachmentNames: 'plan.pdf',
  attachmentSizes: '[1024]',
} as Partial<EmailRecord> & { id: string });

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

type Handlers = Record<'handleReply' | 'handleReplyAll' | 'handleInlineForward' | 'handleForward', ReturnType<typeof vi.fn>>;

/**
 * A ThreadChatView context. Every flag the reply row and the composers read is
 * spelled out: the Proxy's fallback is a `vi.fn()`, and a function is truthy —
 * an unlisted `chatViewActive` would silently read as "on".
 */
const context = (
  threadEmails: EmailRecord[],
  handlers: Handlers,
  overrides: Record<string, unknown> = {},
) =>
  new Proxy(
    {
      displayEmail: threadEmails[0],
      threadEmails,
      conversationMessages: null,
      conversationLoading: false,
      conversationError: null,
      conversationProgress: null,
      showAIView: false,
      chatViewActive: true,
      showInlineReply: false,
      showInlineForward: false,
      replyingToEmail: null,
      forwardingEmail: null,
      inlineReplyDraft: undefined,
      inlineForwardDraft: undefined,
      inlineReplyMode: 'reply',
      handleReExtractMessage: undefined,
      ...handlers,
      ...overrides,
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : vi.fn()) },
  ) as never;

const newHandlers = (): Handlers => ({
  handleReply: vi.fn(),
  handleReplyAll: vi.fn(),
  handleInlineForward: vi.fn(),
  handleForward: vi.fn(),
});

// `all` / `byLabel` search the whole document (tooltips portal out), so every
// mount is torn down before the next test or it answers for this one.
const mounted: Mounted[] = [];
const mount = (element: Parameters<typeof render>[0]) => {
  const view = render(element);
  mounted.push(view);
  return view;
};
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount());
  quickAnswers.length = 0;
  composerLog.length = 0;
  composerProps.reply = undefined;
  composerProps.forward = undefined;
  bubbleClick.mockClear();
  menuProps.clear();
  vi.useRealTimers();
});

/** Tooltip text shown right now, if any (tooltips render `.fixed`). */
const tooltipShowing = (view: Mounted, text: string) =>
  view.all('.fixed').some((el) => el.textContent === text);

/** Hover `element` and let `ms` of the tooltip delay pass. */
const hoverFor = (element: HTMLElement, ms: number) => {
  act(() => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

const endBar = (view: Mounted) => view.byLabel('Reply actions');
const barButton = (view: Mounted, text: string) =>
  [...(endBar(view)?.querySelectorAll('button') ?? [])].find((b) => b.textContent === text) ?? null;
const bubble = (view: Mounted, id: string) => view.find(`[data-message-id="${id}"]`)!;
const iconIn = (element: Element, name: string) =>
  element.querySelector<HTMLElement>(`[aria-label="${name}"]`);

describe('ThreadChatView — the reply row at the end', () => {
  // The feature: the chat ends with the standard view's reply row, after the
  // last bubble, where the composer then opens.
  it('closes the conversation with the reply row', () => {
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], newHandlers())} />);
    const bar = endBar(view)!;
    expect(bar).not.toBeNull();
    expect(
      view.find('[data-testid="chat-view"]')!.compareDocumentPosition(bar) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect([...bar.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'Reply',
      'Reply All',
      'Forward',
    ]);
  });

  // Regression guard: the row answers the NEWEST message, as the shortcuts and
  // the toolbar do — so it passes no email and lets the handler pick. Passing a
  // bubble's email here would answer whichever message that was.
  it('answers the newest message: every handler is called with no email', () => {
    const h = newHandlers();
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], h)} />);
    toggle(barButton(view, 'Reply'));
    toggle(barButton(view, 'Reply All'));
    toggle(barButton(view, 'Forward'));
    expect(h.handleReply.mock.calls).toEqual([[]]);
    expect(h.handleReplyAll.mock.calls).toEqual([[]]);
    expect(h.handleInlineForward.mock.calls).toEqual([[]]);
  });

  // Forward from the chat opens inline, here, like its reply — never the popup.
  it('forwards inline, not in the popup composer', () => {
    const h = newHandlers();
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], h)} />);
    toggle(barButton(view, 'Forward'));
    expect(h.handleForward).not.toHaveBeenCalled();
  });

  // The composer opens in the row's spot; the row would sit on top of the box
  // its own button opened.
  it('hides while a reply is open', () => {
    const view = mount(
      <ThreadChatView
        ctx={context([OPENER, ANSWER], newHandlers(), { showInlineReply: true, replyingToEmail: ANSWER })}
      />,
    );
    expect(view.find('[data-testid="inline-reply"]')).not.toBeNull();
    expect(endBar(view)).toBeNull();
  });

  it('hides while a forward is open', () => {
    const view = mount(
      <ThreadChatView
        ctx={context([OPENER, ANSWER], newHandlers(), { showInlineForward: true, forwardingEmail: ANSWER })}
      />,
    );
    expect(view.find('[data-testid="inline-forward"]')).not.toBeNull();
    expect(endBar(view)).toBeNull();
  });

  // Regression guard: the chat can mount beside the standard card, whose own
  // footer carries this row — two rows, one under each copy of the mail.
  it('hides while the chat is not the reading surface', () => {
    const view = mount(
      <ThreadChatView ctx={context([OPENER, ANSWER], newHandlers(), { chatViewActive: false })} />,
    );
    expect(view.all('[data-testid="bubble"]')).toHaveLength(2);
    expect(endBar(view)).toBeNull();
  });

  // No bubbles, no row: under the "Process now" invitation it would answer a
  // message the reader cannot see.
  it('hides under the "Process now" invitation', () => {
    const view = mount(
      <ThreadChatView ctx={context([OPENER, ANSWER], newHandlers(), { showAIView: true })} />,
    );
    expect(view.all('button').some((b) => b.textContent === 'Process now')).toBe(true);
    expect(endBar(view)).toBeNull();
  });

  it('hides under the placeholders while the AI view is loading, and on an empty thread', () => {
    const loading = mount(
      <ThreadChatView
        ctx={context([OPENER, ANSWER], newHandlers(), { showAIView: true, conversationLoading: true })}
      />,
    );
    expect(endBar(loading)).toBeNull();
    loading.unmount();
    mounted.splice(0);

    const empty = mount(<ThreadChatView ctx={context([], newHandlers())} />);
    expect(endBar(empty)).toBeNull();
  });
});

describe('ThreadChatView — the reply row stays in view', () => {
  /** Every scrollIntoView, with the element it was called on, in order. */
  const scrolled: Element[] = [];
  let original: PropertyDescriptor | undefined;
  beforeEach(() => {
    scrolled.length = 0;
    original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value(this: Element) {
        scrolled.push(this);
      },
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  const NEWER = email({ id: 'newer', date: ELEVEN_AM + 60, rawBody: '<p>One more thing.</p>' });

  // Regression: the library scrolls ITS bottom into view when the last message
  // changes, and the row sits below that — every thread opened with the row
  // just under the fold. The row's scroll must come last.
  it('scrolls the row into view after the library\'s own scroll when a thread opens', () => {
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], newHandlers())} />);
    expect(scrolled.at(-1)).toBe(endBar(view));
    expect(scrolled.some((el) => el.classList.contains('sec-bottom'))).toBe(true);
  });

  it('scrolls it again when a new last message arrives', () => {
    const h = newHandlers();
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], h)} />);
    scrolled.length = 0;
    view.rerender(<ThreadChatView ctx={context([OPENER, ANSWER, NEWER], h)} />);
    expect(scrolled.at(-1)).toBe(endBar(view));
  });

  // Not on every render: a re-render with the same last message (a keystroke
  // upstream, a flag flip) must not yank a reader who scrolled up.
  it('does not scroll again while the last message is the same', () => {
    const h = newHandlers();
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], h)} />);
    scrolled.length = 0;
    view.rerender(<ThreadChatView ctx={context([OPENER, ANSWER], h, { conversationError: null })} />);
    expect(scrolled).toEqual([]);
  });

  // With a composer open the row is not drawn, and nothing scrolls to it.
  it('does not scroll to the row while a composer is open', () => {
    const view = mount(
      <ThreadChatView
        ctx={context([OPENER, ANSWER], newHandlers(), { showInlineReply: true, replyingToEmail: ANSWER })}
      />,
    );
    expect(endBar(view)).toBeNull();
    expect(scrolled.every((el) => el.classList.contains('sec-bottom'))).toBe(true);
  });
});

describe('ThreadChatView — reply icons on each bubble', () => {
  // The feature, and the regression guard on its target: each icon answers
  // ITS bubble's message — here the older one, not the newest.
  it('answers the bubble it sits on', () => {
    const h = newHandlers();
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], h)} />);
    const opener = bubble(view, 'opener');

    toggle(iconIn(opener, 'Reply'));
    toggle(iconIn(opener, 'Reply all'));
    toggle(iconIn(opener, 'Forward'));

    expect(h.handleReply.mock.calls).toEqual([[OPENER, false]]);
    expect(h.handleReplyAll.mock.calls).toEqual([[OPENER, false]]);
    // Inline, like every other forward in the chat.
    expect(h.handleInlineForward.mock.calls).toEqual([[OPENER]]);
    expect(h.handleForward).not.toHaveBeenCalled();
  });

  // Regression guard: a click that reached the bubble would be the bubble's too.
  it('keeps the click off the bubble', () => {
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], newHandlers())} />);
    toggle(iconIn(bubble(view, 'answer'), 'Reply'));
    expect(bubbleClick).not.toHaveBeenCalled();
  });

  // Regression: every bubble's icons share their names with every other
  // bubble's and with the end row's; the group says which message they answer.
  it('names each bubble\'s icons for that bubble\'s message', () => {
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], newHandlers())} />);
    const at = (date: number) => format(new Date(date * 1000), 'MMM d, h:mm a');
    const group = bubble(view, 'opener').querySelector('.sec-quick [role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe(`Reply actions for Alice Chen, ${at(TEN_AM)}`);
    expect(
      bubble(view, 'answer').querySelector('.sec-quick [role="group"]')!.getAttribute('aria-label'),
    ).toBe(`Reply actions for Bob Ray, ${at(ELEVEN_AM)}`);
  });

  // Regression guard for the one set of handlers: the bubble's three-dot menu
  // and its hover icons answer the same way. Two copies drift — the menu's
  // Forward made a popup, say, and the icons left forwarding inline.
  it('answers exactly as the bubble\'s three-dot menu does', () => {
    const viaIcons = newHandlers();
    const icons = mount(<ThreadChatView ctx={context([OPENER, ANSWER], viaIcons)} />);
    for (const name of ['Reply', 'Reply all', 'Forward']) toggle(iconIn(bubble(icons, 'opener'), name));
    icons.unmount();
    mounted.splice(0);

    const viaMenu = newHandlers();
    mount(<ThreadChatView ctx={context([OPENER, ANSWER], viaMenu)} />);
    const menu = menuProps.get('opener')!;
    act(() => {
      menu.onReply();
      menu.onReplyAll();
      menu.onForward();
    });

    for (const key of ['handleReply', 'handleReplyAll', 'handleInlineForward', 'handleForward'] as const) {
      expect(viaMenu[key].mock.calls).toEqual(viaIcons[key].mock.calls);
    }
    expect(viaMenu.handleInlineForward.mock.calls).toEqual([[OPENER]]);
  });

  // Regression: the same bug the attachment strip had. A bubble recovered from
  // a quote has no mail of its own; answering "it" would answer the mail that
  // quoted it, addressed to someone else. It gets no icons; its carrier does.
  it('gives a bubble recovered from a quote no icons', () => {
    const view = mount(<ThreadChatView ctx={context([CARRIER], newHandlers())} />);
    const bubbles = view.all('[data-testid="bubble"]');
    expect(bubbles).toHaveLength(2);

    const recovered = bubbles.find((b) => b.getAttribute('data-message-id') !== 'carrier')!;
    expect(recovered.querySelector('.sec-quick')).toBeNull();
    expect(iconIn(bubble(view, 'carrier'), 'Reply')).not.toBeNull();
  });

  // Icon-only controls: each has an accessible name and the shared Tooltip at
  // 40ms — and no shortcut chip, because the shortcuts answer the newest
  // message, not the bubble under the pointer.
  it('names every icon, in a 40ms tooltip with no shortcut hint', () => {
    vi.useFakeTimers();
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], newHandlers())} />);
    const quick = bubble(view, 'opener').querySelector('.sec-quick')!;
    expect(
      [...quick.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Reply', 'Reply all', 'Forward']);

    hoverFor(iconIn(quick, 'Forward')!, 39);
    expect(tooltipShowing(view, 'Forward')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const tip = view.all('.fixed').find((el) => el.textContent === 'Forward');
    expect(tip).toBeDefined();
    expect(tip!.querySelector('kbd')).toBeNull();
  });

  // Regression guard: the library re-mounts a bubble whose slot answer flips
  // between nothing and something, and a framed body reloads with it. The
  // answer must depend on the message alone — not on an open composer, not on
  // whether the chat is the reading surface.
  it('answers the same for a message whatever the composer and view state', () => {
    const answersFor = (overrides: Record<string, unknown>) => {
      quickAnswers.length = 0;
      const view = mount(<ThreadChatView ctx={context([CARRIER, ANSWER], newHandlers(), overrides)} />);
      const answers = quickAnswers.map((a) => `${a.id}:${a.answered}`);
      view.unmount();
      mounted.splice(0);
      return answers;
    };
    const idle = answersFor({});
    expect(idle).toContain('carrier:true');
    expect(idle.some((a) => a.endsWith(':false'))).toBe(true); // the recovered quote
    expect(answersFor({ showInlineReply: true, replyingToEmail: ANSWER })).toEqual(idle);
    expect(answersFor({ showInlineForward: true, forwardingEmail: ANSWER })).toEqual(idle);
    expect(answersFor({ chatViewActive: false })).toEqual(idle);
  });
});

describe('ThreadChatView — the one composer', () => {
  // Regression: the chat has ONE reply composer for every bubble, and it was
  // not keyed. Replying to bubble B with A's reply open kept A's body and
  // draft, and re-derived recipients only if the sender changed — B's reply
  // went out as A's. A new target must mount a fresh composer.
  it('mounts a fresh reply composer when the reply moves to another message', () => {
    const h = newHandlers();
    const view = mount(
      <ThreadChatView ctx={context([OPENER, ANSWER], h, { showInlineReply: true, replyingToEmail: OPENER })} />,
    );
    expect(composerLog).toEqual(['reply:mount:opener']);

    view.rerender(
      <ThreadChatView ctx={context([OPENER, ANSWER], h, { showInlineReply: true, replyingToEmail: ANSWER })} />,
    );
    expect(composerLog).toEqual(['reply:mount:opener', 'reply:unmount:opener', 'reply:mount:answer']);
    expect((composerProps.reply!.replyToEmail as { id: string }).id).toBe('answer');
  });

  // The other half: re-rendering the SAME reply (a mode switch, a keystroke
  // upstream) must not throw away what is being typed.
  it('keeps the reply composer while it stays on the same message', () => {
    const h = newHandlers();
    const view = mount(
      <ThreadChatView ctx={context([OPENER, ANSWER], h, { showInlineReply: true, replyingToEmail: ANSWER })} />,
    );
    view.rerender(
      <ThreadChatView
        ctx={context([OPENER, ANSWER], h, {
          showInlineReply: true,
          replyingToEmail: ANSWER,
          inlineReplyMode: 'replyAll',
        })}
      />,
    );
    expect(composerLog).toEqual(['reply:mount:answer']);
    expect(composerProps.reply!.mode).toBe('replyAll');
  });

  // Regression: the forward composer was unkeyed too, and its attachment fetch
  // APPENDS — forwarding a second bubble added its files to the first one's.
  it('mounts a fresh forward composer when the forward moves to another message', () => {
    const h = newHandlers();
    const view = mount(
      <ThreadChatView ctx={context([OPENER, ANSWER], h, { showInlineForward: true, forwardingEmail: OPENER })} />,
    );
    view.rerender(
      <ThreadChatView ctx={context([OPENER, ANSWER], h, { showInlineForward: true, forwardingEmail: ANSWER })} />,
    );
    expect(composerLog).toEqual([
      'forward:mount:opener',
      'forward:unmount:opener',
      'forward:mount:answer',
    ]);
  });

  // Regression: the chat handed the forward box the raw row and no draft. A
  // forward reopened by Undo send came back empty, and the row is not the
  // box's input — the one mapping (`toForwardSource`) is what carries the
  // attachment fields that let the forward re-attach the original's files.
  it('opens the forward from the mapped source, with the restored draft', () => {
    const draft = { to: 'carol@acme.example', cc: '', htmlContent: '<p>FYI</p>', attachments: [] };
    mount(
      <ThreadChatView
        ctx={context([OPENER, ANSWER], newHandlers(), {
          showInlineForward: true,
          forwardingEmail: ANSWER,
          inlineForwardDraft: draft,
        })}
      />,
    );
    expect(composerProps.forward!.forwardEmail).toEqual(toForwardSource(ANSWER));
    expect(composerProps.forward!.draft).toBe(draft);
  });

  // Regression: with the chat beside the standard card (it is not the reading
  // surface), EmailDetail mounts the first message's reply under that card —
  // and the chat mounted a second one. Two composers, two autosaved drafts.
  it('leaves the first message\'s reply to the standard card when the chat is beside it', () => {
    mount(
      <ThreadChatView
        ctx={context([OPENER, ANSWER], newHandlers(), {
          chatViewActive: false,
          showInlineReply: true,
          replyingToEmail: OPENER,
        })}
      />,
    );
    expect(composerLog).toEqual([]);
  });

  it('leaves the first message\'s forward to the standard card when the chat is beside it', () => {
    mount(
      <ThreadChatView
        ctx={context([OPENER, ANSWER], newHandlers(), {
          chatViewActive: false,
          showInlineForward: true,
          forwardingEmail: OPENER,
        })}
      />,
    );
    expect(composerLog).toEqual([]);
  });

  // The card mounts nothing for any other message, so the chat still does.
  it('still mounts a reply to any other message there', () => {
    mount(
      <ThreadChatView
        ctx={context([OPENER, ANSWER], newHandlers(), {
          chatViewActive: false,
          showInlineReply: true,
          replyingToEmail: ANSWER,
        })}
      />,
    );
    expect(composerLog).toEqual(['reply:mount:answer']);
  });

  // The reply side already passed its draft; pinned so it stays passed.
  it('opens the reply with the restored draft', () => {
    const draft = { to: 'bob@acme.example', cc: '', htmlContent: '<p>Thanks</p>', attachments: [] };
    mount(
      <ThreadChatView
        ctx={context([OPENER, ANSWER], newHandlers(), {
          showInlineReply: true,
          replyingToEmail: ANSWER,
          inlineReplyDraft: draft,
        })}
      />,
    );
    expect(composerProps.reply!.draft).toBe(draft);
  });
});

describe('ThreadChatView — the re-extract icons', () => {
  /** The AI view's turns for OPENER and ANSWER, one per mail. */
  const turns = (failed = false) =>
    [OPENER, ANSWER].map((mail) => ({
      id: mail.id,
      sourceEmailId: mail.id,
      fromAddress: mail.fromAddress,
      fromName: mail.fromName,
      toAddress: mail.toAddress,
      date: mail.date,
      body: mail.rawBody,
      isExtracted: false,
      extractionFailed: failed && mail.id === 'opener',
    }));

  const aiView = (overrides: Record<string, unknown> = {}) =>
    context([OPENER, ANSWER], newHandlers(), {
      showAIView: true,
      conversationMessages: turns(),
      handleReExtractMessage: vi.fn(async () => {}),
      ...overrides,
    });

  // Regression: the thread-level icon had a tooltip but no accessible name,
  // and the default 150ms delay.
  it('names the thread-level re-extract icon, in a 40ms tooltip', () => {
    vi.useFakeTimers();
    const view = mount(<ThreadChatView ctx={aiView()} />);
    const button = view.byLabel('Re-extract conversation')!;
    expect(button.tagName).toBe('BUTTON');

    hoverFor(button, 39);
    expect(tooltipShowing(view, 'Re-extract conversation')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(tooltipShowing(view, 'Re-extract conversation')).toBe(true);
  });

  // Regression: the pill's `backdrop-filter` made it the containing block of
  // the tooltip, which is `position: fixed` at viewport coordinates — so the
  // tooltip landed offset by the pill's own position, far from the icon. The
  // frosted glass is now a layer beside the controls, never around them.
  it('keeps the frosted glass off the tooltip\'s ancestors', () => {
    const view = mount(<ThreadChatView ctx={aiView()} />);
    const button = view.byLabel('Re-extract conversation')!;
    const frosted = view.find('[data-pill-backdrop]')!;
    expect(frosted.className).toMatch(/\bbackdrop-blur-md\b/);
    expect(frosted.contains(button)).toBe(false);
    for (let el: HTMLElement | null = button; el && el !== view.container; el = el.parentElement) {
      expect(el.className).not.toMatch(/\bbackdrop-/);
    }
  });

  // The thread-level icon's warning tint is its state: no ghost hover
  // background beside the orange one.
  it('draws the thread-level icon\'s own tint, with no competing hover background', () => {
    const view = mount(<ThreadChatView ctx={aiView({ conversationMessages: turns(true) })} />);
    const classes = view
      .byLabel('Some messages need AI processing — click to extract again')!
      .className.split(/\s+/);
    expect(classes).toContain('hover:bg-orange-500/10');
    expect(classes).not.toContain('hover:bg-accent');
  });

  // Its name follows its state, the same string as the tooltip.
  it('names the thread-level icon by its state', () => {
    const failed = mount(<ThreadChatView ctx={aiView({ conversationMessages: turns(true) })} />);
    expect(failed.byLabel('Some messages need AI processing — click to extract again')).not.toBeNull();
    failed.unmount();
    mounted.splice(0);

    const running = mount(<ThreadChatView ctx={aiView({ conversationLoading: true })} />);
    expect(running.byLabel('Extracting…')).not.toBeNull();
  });

  // Regression: the per-bubble icon had a tooltip and no accessible name.
  it('names the per-bubble re-extract icon by its state', () => {
    const view = mount(<ThreadChatView ctx={aiView({ conversationMessages: turns(true) })} />);
    expect(iconIn(bubble(view, 'answer'), 'Re-extract this message with AI')).not.toBeNull();
    expect(iconIn(bubble(view, 'opener'), 'Process this message with AI')).not.toBeNull();
  });

  // Its tooltip at the project's 40ms, not sooner.
  it('shows the per-bubble re-extract tooltip at 40ms', () => {
    vi.useFakeTimers();
    const view = mount(<ThreadChatView ctx={aiView()} />);
    hoverFor(iconIn(bubble(view, 'answer'), 'Re-extract this message with AI')!, 39);
    expect(tooltipShowing(view, 'Re-extract this message with AI')).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(tooltipShowing(view, 'Re-extract this message with AI')).toBe(true);
  });
});

describe('ThreadChatView — the star and menu on each bubble', () => {
  // The star is named by what a click does, and its click stays off the bubble.
  it('names the star by its action and keeps the click to itself', () => {
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], newHandlers())} />);
    const star = iconIn(bubble(view, 'answer'), 'Star')!;
    expect(star.tagName).toBe('BUTTON');
    toggle(star);
    expect(storeState.markMessageStarred).toHaveBeenCalledWith('answer', true);
    expect(bubbleClick).not.toHaveBeenCalled();
    storeState.markMessageStarred.mockClear();
  });

  it('offers Unstar on a starred message', () => {
    const starred = { ...ANSWER, tags: '|starred|' };
    const view = mount(<ThreadChatView ctx={context([OPENER, starred], newHandlers())} />);
    toggle(iconIn(bubble(view, 'answer'), 'Unstar'));
    expect(storeState.markMessageStarred).toHaveBeenCalledWith('answer', false);
    storeState.markMessageStarred.mockClear();
  });

  // Every bubble has a "Star" and a menu; the group names whose they are.
  it('names the cluster for its message', () => {
    const view = mount(<ThreadChatView ctx={context([OPENER, ANSWER], newHandlers())} />);
    const group = bubble(view, 'answer').querySelector('.sec-actions [role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe(
      `Message actions for Bob Ray, ${format(new Date(ELEVEN_AM * 1000), 'MMM d, h:mm a')}`,
    );
  });
});
