// @vitest-environment happy-dom
import type { EmailRecord } from '@sarvinbox/core';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { render, toggle, type Mounted } from '../../../../helpers/render';

import { chatFieldsFor, splitRow, type ChatFieldsOptions } from './chat-context-fixture';
import { email } from './email-fixture';
import { ALICE_TEXT, BOB_TEXT, DAN_TEXT, LOOPED_AT, loopedInEmail, loopedInParts } from './looped-in-fixture';

/**
 * The chat view's AI mode: Standard's bubbles as they are, except the FIRST
 * email, whose quoted history the AI split into the messages it quotes.
 *
 * What breaks if this file goes red: the AI view goes back to dropping every
 * later email (it used to render only what a whole-thread extraction had
 * produced), a missing or failed split blanks the pane instead of leaving the
 * first email as Standard shows it, the "Process now" invitation hides the
 * bubbles, or the AI toggle is offered on a thread with nothing for AI to do.
 */

vi.mock('@sarv-in/email-chat-view', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MailChatView: ({
    messages,
    renderActions,
    loading,
    onRetryBody,
  }: {
    messages: readonly { id: string; body: string }[];
    renderActions?: (message: { id: string }) => ReactNode;
    loading?: boolean;
    onRetryBody?: (message: { id: string }) => void;
  }) => (
    <div data-testid="chat-view" data-loading={String(!!loading)}>
      {messages.map((message) => (
        <div key={message.id} data-testid="bubble" data-message-id={message.id}>
          <div data-testid="bubble-body" dangerouslySetInnerHTML={{ __html: message.body }} />
          <div className="sec-actions">{renderActions?.(message)}</div>
          {/* The library's own body-retry control, as a plain button here. */}
          <button type="button" data-retry-body={message.id} onClick={() => onRetryBody?.(message)}>retry body</button>
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
  getCurrentUserEmail: () => 'me@acme.example',
}));
vi.mock('../../../../../src/services/image-cache', () => ({
  resolveRefsInHtml: (html: string) => html,
}));
vi.mock('../../../../../src/store/helpers', () => ({
  qualifiesForSafeAutoLoad: () => false,
  shouldAutoLoadRemoteImages: () => false,
}));

const setStoreState = vi.fn();
const storeState = {
  failedBodies: new Set<string>(),
  fetchEmailBody: vi.fn(),
  markMessageStarred: vi.fn(),
  clearSelectedEmail: vi.fn(),
};
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: Object.assign(
    (select: (state: typeof storeState) => unknown) => select(storeState),
    { getState: () => storeState, setState: (update: unknown) => setStoreState(update) },
  ),
}));

const { ThreadChatView } = await import('../../../../../src/components/email-detail/ThreadChatView');

/** Dan's looped-in mail (the first email), and the reader's colleague answering it. */
const FIRST = loopedInEmail();
const REPLY = email({
  id: 'e2',
  date: LOOPED_AT + 3600,
  fromName: 'Bob Ray',
  fromAddress: 'bob@acme.example',
  rawBody: '<p>Thanks Dan — I will bring the forecast on Friday.</p>',
});
const THREAD = [FIRST, REPLY];

/** Rules for a thread whose first email quotes 2+ messages, AI configured. */
const AUTO_RULES = { eligibility: 'auto', showAiToggle: true, aiAvailable: true, autoRunAI: true } as const;

const context = (
  threadEmails: EmailRecord[],
  overrides: Record<string, unknown> = {},
  chat: ChatFieldsOptions = {},
) => {
  const fields = chatFieldsFor(threadEmails, chat);
  return new Proxy(
    {
      displayEmail: threadEmails[0],
      threadEmails,
      ...fields,
      showAIView: true,
      chatViewActive: true,
      showInlineReply: false,
      showInlineForward: false,
      replyingToEmail: null,
      forwardingEmail: null,
      inlineReplyDraft: undefined,
      inlineForwardDraft: undefined,
      inlineReplyMode: 'reply',
      ...overrides,
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : vi.fn()) },
  ) as never as { firstSplit: { run: ReturnType<typeof vi.fn> } };
};

const mounted: Mounted[] = [];
const mount = (ctx: ReturnType<typeof context>) => {
  const view = render(<ThreadChatView ctx={ctx as never} />);
  mounted.push(view);
  return view;
};
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount());
});

// Scoped to one mount's container: a test may mount two views side by side.
const ids = (view: Mounted) =>
  [...view.container.querySelectorAll('[data-testid="bubble"]')].map((el) => el.getAttribute('data-message-id'));
const bubbleText = (view: Mounted, id: string) =>
  view.container.querySelector(`[data-message-id="${id}"] [data-testid="bubble-body"]`)?.textContent ?? '';
const banner = (view: Mounted) => view.container.querySelector('[data-first-slot]');
const button = (view: Mounted, text: string) =>
  [...view.container.querySelectorAll('button')].find((each) => each.textContent === text) ?? null;

/** Standard's bubble ids for the thread (what the AI view shows without a split). */
const standardIds = () => chatFieldsFor(THREAD).standardTurns.turns.map((turn) => turn.id);

describe('ThreadChatView — the AI view', () => {
  // THE regression: with nothing split yet the AI view showed an empty pane
  // (and, before that, only what an extraction had produced — every later
  // email vanished). Now: the Process-now banner ABOVE Standard's bubbles.
  it('shows the Process-now banner AND every Standard bubble when there is no split', () => {
    const ctx = context(THREAD, {}, { chatRules: AUTO_RULES, firstSplit: { state: 'miss' } });
    const view = mount(ctx);
    expect(banner(view)!.getAttribute('data-first-slot')).toBe('process');
    expect(ids(view)).toEqual(standardIds());
    expect(ids(view)).toContain('e2');
    // Never a full-pane spinner over the bubbles.
    expect(view.container.querySelector('[data-testid="chat-view"]')!.getAttribute('data-loading')).toBe('false');

    toggle(button(view, 'Process now'));
    expect(ctx.firstSplit.run).toHaveBeenCalledTimes(1);
  });

  // With a usable split, the first email's slot is its split parts, and every
  // later email is Standard's bubble, untouched.
  it('shows the split parts in the first email\'s slot and the later bubbles unchanged', () => {
    const view = mount(context(THREAD, {}, { chatRules: AUTO_RULES, parts: loopedInParts() }));
    expect(ids(view)).toEqual(['e1#ai1', 'e1#ai2', 'e1#ai3', 'e1', 'e2']);
    expect(bubbleText(view, 'e1#ai1')).toContain(ALICE_TEXT);
    expect(bubbleText(view, 'e1#ai2')).toContain(BOB_TEXT);
    expect(bubbleText(view, 'e1')).toContain(DAN_TEXT);
    // The later reply is exactly what Standard shows.
    const standard = mount(context(THREAD, { showAIView: false }, { chatRules: AUTO_RULES, parts: loopedInParts() }));
    expect(bubbleText(view, 'e2')).toBe(bubbleText(standard, 'e2'));
    expect(banner(view)!.getAttribute('data-first-slot')).toBe('resplit');
  });

  // The Standard half over the same cached split is Standard's own list.
  it('shows Standard\'s own bubbles on the Standard half, with no banner', () => {
    const view = mount(context(THREAD, { showAIView: false }, { chatRules: AUTO_RULES, parts: loopedInParts() }));
    expect(ids(view)).toEqual(standardIds());
    expect(banner(view)).toBeNull();
  });

  // A failed split never blanks the pane: the first email's slot stays as
  // Standard shows it, with the reason and Try again above.
  it('shows Standard\'s first-email bubbles plus Try again when the split failed', () => {
    const row = splitRow(loopedInParts(), { status: 'failed', parts: null, errorKind: 'client' });
    const ctx = context(THREAD, {}, { chatRules: AUTO_RULES, firstSplit: { state: 'failed', row } });
    const view = mount(ctx);
    expect(ids(view)).toEqual(standardIds());
    expect(banner(view)!.textContent).toContain('The AI provider refused the request.');
    toggle(button(view, 'Try again'));
    expect(ctx.firstSplit.run).toHaveBeenCalledTimes(1);
  });

  // A transient failure that will retry by itself says so — and still lets
  // the reader retry now.
  it('says a transient failure will retry automatically, and offers Retry now', () => {
    const row = splitRow(loopedInParts(), { status: 'transient', parts: null, errorKind: 'rate_limit', attempts: 1 });
    const ctx = context(THREAD, {}, { chatRules: AUTO_RULES, firstSplit: { state: 'retry-later', row } });
    const view = mount(ctx);
    expect(banner(view)!.textContent).toContain('will retry automatically');
    expect(banner(view)!.textContent).toContain('limiting requests');
    toggle(button(view, 'Retry now'));
    expect(ctx.firstSplit.run).toHaveBeenCalledTimes(1);
  });

  // A forced re-split that failed transiently is KEPT by main (a failure
  // never replaces a good split), so nothing on screen changes. Without this
  // line the reader's click looked like it did nothing at all.
  it('says a re-split failed and the previous split is kept, until the next run', () => {
    const lastManualRun = {
      state: 'saved',
      current: { threadId: 't', firstKey: 'k', firstEmailId: 'e1', fingerprint: 'f', memberCount: 2, distinctSenders: 2 },
      outcome: { status: 'transient', errorKind: 'timeout', regions: 1, chunks: 1, fallbackRegions: 0, aiParts: 0, fallbackParts: 0, rejected: {} },
      save: { applied: false, reason: 'kept' },
    } as const;
    const view = mount(context(THREAD, {}, { chatRules: AUTO_RULES, parts: loopedInParts(), firstSplit: { lastManualRun } }));
    expect(banner(view)!.getAttribute('data-first-slot')).toBe('resplit');
    expect(view.container.querySelector('[data-first-slot-notice]')!.textContent)
      .toBe('Re-split failed. The AI provider took too long to answer. The previous split is kept.');
    // The split itself still shows.
    expect(ids(view)).toEqual(['e1#ai1', 'e1#ai2', 'e1#ai3', 'e1', 'e2']);

    // While a run is going the spinner line speaks alone.
    const busy = mount(context(THREAD, {}, {
      chatRules: AUTO_RULES, parts: loopedInParts(), firstSplit: { lastManualRun, running: true },
    }));
    expect(banner(busy)!.getAttribute('data-first-slot')).toBe('running');
    expect(busy.container.querySelector('[data-first-slot-notice]')).toBeNull();

    // No click yet: no notice.
    const quiet = mount(context(THREAD, {}, { chatRules: AUTO_RULES, parts: loopedInParts() }));
    expect(quiet.container.querySelector('[data-first-slot-notice]')).toBeNull();
  });

  // A run in flight: a spinner and the provider's status, bubbles below.
  it('shows a run in flight with its status text over the bubbles', () => {
    const view = mount(context(THREAD, {}, {
      chatRules: AUTO_RULES,
      firstSplit: { state: 'miss', running: true, status: 'AI provider busy — retrying in 8s' },
    }));
    expect(banner(view)!.getAttribute('data-first-slot')).toBe('running');
    expect(banner(view)!.textContent).toContain('retrying in 8s');
    expect(ids(view)).toEqual(standardIds());

    const quiet = mount(context(THREAD, {}, { chatRules: AUTO_RULES, firstSplit: { state: 'miss', running: true } }));
    expect(banner(quiet)!.textContent).toContain('Splitting');
  });

  // A partial split says some parts show as in Standard.
  it('says so when the split is partial', () => {
    const parts = loopedInParts();
    parts[1] = { ...parts[1]!, fallback: true };
    const view = mount(context(THREAD, {}, { chatRules: AUTO_RULES, parts }));
    expect(banner(view)!.textContent).toContain('could not split');
  });

  // A thread whose first email quotes nothing has nothing for AI: no pill at
  // all, and the Standard bubbles even if the AI half was selected before.
  it('hides the AI pill when the first email quotes nothing', () => {
    const view = mount(context(THREAD, { showAIView: true }, {
      chatRules: { eligibility: 'none', showAiToggle: false, aiAvailable: true },
      firstSplit: { state: 'miss' },
    }));
    expect(button(view, 'AI View')).toBeNull();
    expect(button(view, 'Standard')).toBeNull();
    expect(banner(view)).toBeNull();
    expect(ids(view)).toEqual(standardIds());
  });

  // The pill's halves switch the view.
  it('switches halves from the pill', () => {
    const setShowAIView = vi.fn();
    const view = mount(context(THREAD, { showAIView: false, setShowAIView }, { chatRules: AUTO_RULES }));
    toggle([...view.container.querySelectorAll('button')].find((b) => b.textContent?.includes('AI View'))!);
    toggle(button(view, 'Standard'));
    expect(setShowAIView.mock.calls).toEqual([[true], [false]]);
  });

  // No Standard turns handed down (nothing to show yet): an empty view, not a crash.
  it('renders an empty view without Standard turns', () => {
    const view = mount(context(THREAD, { standardTurns: null, showAIView: false }, { chatRules: AUTO_RULES }));
    expect(ids(view)).toEqual([]);
  });

  // A body that failed to download: the bubble's retry clears the failure and
  // fetches it again — for the bubble's own mail; a quote has none to fetch.
  it('retries a failed body for the bubble\'s own mail only', () => {
    storeState.fetchEmailBody.mockClear();
    setStoreState.mockClear();
    const view = mount(context(THREAD, { showAIView: false }, { chatRules: AUTO_RULES }));
    toggle(view.container.querySelector('[data-retry-body="e2"]'));
    expect(storeState.fetchEmailBody).toHaveBeenCalledWith('e2');
    const update = setStoreState.mock.calls[0]![0] as (s: { failedBodies: Set<string> }) => { failedBodies: Set<string> };
    expect(update({ failedBodies: new Set(['e2', 'x']) }).failedBodies).toEqual(new Set(['x']));
    const quote = ids(view).find((id) => id?.startsWith('e1#'))!;
    storeState.fetchEmailBody.mockClear();
    toggle(view.container.querySelector(`[data-retry-body="${quote}"]`));
    expect(storeState.fetchEmailBody).not.toHaveBeenCalled();
  });

  // With something for AI to do, the pill is there, the selected half pressed.
  it('shows the pill with the selected half pressed', () => {
    const view = mount(context(THREAD, { showAIView: false }, { chatRules: AUTO_RULES }));
    expect(button(view, 'Standard')!.getAttribute('aria-pressed')).toBe('true');
    expect([...view.container.querySelectorAll('button')].find((b) => b.textContent?.includes('AI View'))!.getAttribute('aria-pressed')).toBe('false');
  });
});
