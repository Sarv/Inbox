// Decision functions for the chat view. All but the last are pure; the last one
// reads the reader's image settings, so this file installs a localStorage and
// an electronAPI for it.
import type { EmailRecord } from '@sarvinbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FirstEmailFacts } from '../../../../../src/components/email-detail/ai-view-compose';
import {
  aiEligibilityFor,
  blockRemoteImagesFor,
  chatMountsComposer,
  chatSourceFor,
  chatViewRulesFor,
  firstSlotPromptFor,
  manualRunNoticeFor,
  shouldShowEndReplyBar,
  splitFailureReason,
  type ChatViewRulesInput,
} from '../../../../../src/components/email-detail/chat-view-rules';
import type { SplitOutcome } from '../../../../../src/services/first-split/split-first-email';
import type { FirstSplitRunResult } from '../../../../../src/services/first-split/store';
import {
  clearImageAllowedCache,
  warmImageAllowedSenders,
} from '../../../../../src/store/helpers';

// helpers.ts pulls in the badge cache and ai-service on import; neither is what
// these tests are about, and ai-service reaches for providers/HTTP at import
// time. (vi.mock is hoisted above the imports above.)
vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(),
  applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: vi.fn(() => ['newsletters'] as string[]),
  warmCategoryDefs: vi.fn(),
}));
vi.mock('../../../../../src/services/ai-service', () => ({
  reportAIHealthy: vi.fn(),
  reportAIUnhealthy: vi.fn(),
  getDefaultProvider: vi.fn(() => null as unknown),
  syncAIProviderToMain: vi.fn(),
}));

const SETTINGS_KEY = 'sarvinbox-settings';

/** Minimal in-memory localStorage — the vitest env is 'node', which has none. */
const installLocalStorage = () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
};

const writeRemoteImageMode = (mode: string) =>
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteImageMode: mode }));

/** Load the allowlist the way the app does, from a stubbed IPC bridge. */
const withAllowedSenders = async (addresses: string[]) => {
  (globalThis as any).window = {
    electronAPI: {
      emails: { getImageAllowedSenders: vi.fn().mockResolvedValue({ success: true, data: addresses }) },
    },
  };
  await warmImageAllowedSenders();
};

const mail = (over: Partial<EmailRecord> = {}): EmailRecord =>
  ({ id: 'e1', fromAddress: 'sender@example.com', tags: '|INBOX|', ...over }) as EmailRecord;

// REPLACED on purpose (with the whole-thread extraction): the AI view used to
// render ONLY extracted turns — nothing at all for an unprocessed thread (the
// old "renders nothing in the AI view" test) and an invitation INSTEAD of the
// bubbles (the old `shouldShowProcessPrompt`). It is now Standard's bubbles
// with the first email's slot replaced, so there is no empty source, and the
// "Process now" banner sits above the bubbles (`firstSlotPromptFor`, below).
describe('chatSourceFor', () => {
  // Regression: the AI view emptied the pane (and dropped every later email)
  // whenever the split was missing or had failed.
  it('shows Standard\'s turns whenever there is no usable split, AI view or not', () => {
    expect(chatSourceFor(true, false)).toBe('thread');
    expect(chatSourceFor(false, false)).toBe('thread');
  });

  // The composition is shown only on the AI half: Standard is the view that
  // never depends on AI output.
  it('uses the split only on the AI half with a usable split', () => {
    expect(chatSourceFor(true, true)).toBe('ai');
    expect(chatSourceFor(false, true)).toBe('thread');
  });
});

// The banner says what went wrong in the reader's terms. A kind the build
// does not know (the column is free text) reads as a plain failure — never
// blank, never a code.
describe('splitFailureReason', () => {
  it.each([
    ['rate_limit', 'limiting requests'],
    ['upstream', 'server error'],
    ['server', 'server error'],
    ['network', 'could not be reached'],
    ['timeout', 'too long'],
    ['empty', 'could not be read'],
    ['unparseable', 'could not be read'],
    ['client', 'refused the request'],
    ['unusable', 'no messages'],
    ['too_large', 'too large'],
    ['unknown', 'did not work'],
    ['from-a-newer-build', 'did not work'],
  ])('explains %s', (kind, words) => {
    expect(splitFailureReason(kind)).toContain(words);
  });

  it('explains a missing kind', () => {
    expect(splitFailureReason(null)).toBe('The AI split did not work.');
    expect(splitFailureReason(undefined)).toBe('The AI split did not work.');
  });
});

// The reader's click must never look like it did nothing: a run that
// persisted no row (so the banner is unchanged) gets one line saying what
// happened. A run that persisted a row gets none — the row's own state and
// reason show instead, and a second line would contradict or repeat them.
describe('manualRunNoticeFor', () => {
  const CURRENT = { threadId: 't', firstKey: 'k', firstEmailId: 'e', fingerprint: 'f', memberCount: 1, distinctSenders: 1 };
  const outcome = (over: Partial<SplitOutcome>): SplitOutcome => ({
    status: 'transient', regions: 1, chunks: 1, fallbackRegions: 0, aiParts: 0, fallbackParts: 0, rejected: {}, ...over,
  });
  const saved = (out: Partial<SplitOutcome>, save: { applied: boolean; reason?: 'stale' | 'kept' | 'invalid' }): FirstSplitRunResult =>
    ({ state: 'saved', current: CURRENT, outcome: outcome(out), save });

  it('says a failed re-split kept the previous split, with the reason', () => {
    expect(manualRunNoticeFor(saved({ status: 'transient', errorKind: 'timeout' }, { applied: false, reason: 'kept' })))
      .toBe('Re-split failed. The AI provider took too long to answer. The previous split is kept.');
    expect(manualRunNoticeFor(saved({ status: 'failed', errorKind: 'client' }, { applied: false, reason: 'kept' })))
      .toContain('refused the request');
  });

  it('says a lesser split did not replace the one shown', () => {
    expect(manualRunNoticeFor(saved({ status: 'partial', errorKind: undefined }, { applied: false, reason: 'kept' })))
      .toContain('not better than the one shown');
  });

  it.each([
    ['a stale save', saved({ status: 'ok' }, { applied: false, reason: 'stale' }), 'changed while it was being split'],
    ['an invalid save', saved({ status: 'ok' }, { applied: false, reason: 'invalid' }), 'could not be saved'],
    ['a provider failure', { state: 'provider', current: CURRENT, outcome: outcome({ status: 'provider' }) } as FirstSplitRunResult, 'provider could not be used'],
    ['an IPC error', { state: 'error', error: 'db threw' } as FirstSplitRunResult, 'could not be run or saved'],
    ['no body to split', { state: 'unknown' } as FirstSplitRunResult, 'not ready'],
  ])('explains %s', (_name, result, words) => {
    expect(manualRunNoticeFor(result)).toContain(words);
  });

  it.each([
    ['no run yet', null],
    ['a persisted save (the row speaks)', saved({ status: 'transient', errorKind: 'timeout' }, { applied: true })],
    ['a cached usable split', { state: 'usable', current: CURRENT, row: {} } as FirstSplitRunResult],
    ['a guarded automatic run', { state: 'guarded', current: CURRENT } as FirstSplitRunResult],
  ])('says nothing for %s', (_name, result) => {
    expect(manualRunNoticeFor(result)).toBeNull();
  });
});

describe('shouldShowEndReplyBar', () => {
  const base = { chatViewActive: true, renderedCount: 3, composerOpen: false };

  // The feature: the chat ends with the same Reply / Reply All / Forward row
  // the standard view puts under a message. Without it the only way to answer
  // from the chat was the toolbar at the top of a long thread.
  it('closes a rendered conversation with the reply row', () => {
    expect(shouldShowEndReplyBar(base)).toBe(true);
  });

  // Regression guard: the chat can mount beside the standard card (a single
  // designed mail with a quoted history, before the reader picks chat). That
  // card has the row in its own footer, so a second one here is a duplicate.
  it('stays away while the chat is not the reading surface', () => {
    expect(shouldShowEndReplyBar({ ...base, chatViewActive: false })).toBe(false);
  });

  // With nothing rendered the view shows placeholders, the "Process now"
  // invitation or its empty text — reply buttons under those answer nothing
  // the reader can see.
  it('stays away while no bubble is rendered', () => {
    expect(shouldShowEndReplyBar({ ...base, renderedCount: 0 })).toBe(false);
  });

  // The composer opens in this very spot; the row would sit on top of the box
  // its own button just opened.
  it('stays away while a reply or forward is open', () => {
    expect(shouldShowEndReplyBar({ ...base, composerOpen: true })).toBe(false);
  });
});

describe('chatMountsComposer', () => {
  // The chat is the reading surface: every reply and forward opens in it.
  it('takes every box while the chat is the reading surface', () => {
    expect(chatMountsComposer({ chatViewActive: true, targetId: 'anchor', anchorId: 'anchor' })).toBe(true);
    expect(chatMountsComposer({ chatViewActive: true, targetId: 'reply', anchorId: 'anchor' })).toBe(true);
  });

  // Regression: with the chat beside the standard card, the card mounts the
  // first message's box — and the chat mounted it too. Two composers on one
  // reply, each autosaving a draft of its own.
  it('leaves the first message\'s box to the standard card when the chat is beside it', () => {
    expect(chatMountsComposer({ chatViewActive: false, targetId: 'anchor', anchorId: 'anchor' })).toBe(false);
  });

  // The card mounts nothing for any other message, so the chat must — or the
  // box a Reply just opened is nowhere.
  it('takes any other message\'s box even then', () => {
    expect(chatMountsComposer({ chatViewActive: false, targetId: 'reply', anchorId: 'anchor' })).toBe(true);
    expect(chatMountsComposer({ chatViewActive: false, targetId: 'reply', anchorId: undefined })).toBe(true);
  });
});

describe('blockRemoteImagesFor', () => {
  beforeEach(() => {
    installLocalStorage();
    (globalThis as any).window = { electronAPI: {} };
    clearImageAllowedCache();
    vi.clearAllMocks();
  });

  // Regression: THE bug this function exists for. The chat view got no
  // blockRemoteImages prop at all, so the library's block-everything default
  // won and a reader who had chosen "always load" still saw the banner —
  // while the classic card, on the very same mail, loaded the images.
  it('loads images when the reader chose "always"', () => {
    writeRemoteImageMode('always');
    expect(blockRemoteImagesFor(mail())).toBe(false);
  });

  // Regression: the other extreme must survive too — "block" is a privacy
  // choice, and an inverted boolean here would leak every remote fetch.
  it('blocks images when the reader chose "block"', () => {
    writeRemoteImageMode('block');
    expect(blockRemoteImagesFor(mail())).toBe(true);
  });

  // Regression: 'safe' (the default) defers to the AI category, so the same
  // setting must give two different answers on two different mails. A
  // thread-level boolean could not express this, which is why the library
  // prop had to become a per-message predicate.
  it('defers to the category under "safe", per message', () => {
    writeRemoteImageMode('safe');
    expect(blockRemoteImagesFor(mail({ tags: '|INBOX|newsletters|' }))).toBe(false);
    expect(blockRemoteImagesFor(mail({ tags: '|INBOX|promotions|' }))).toBe(true);
  });

  // Regression: an allowlisted sender is an explicit per-sender decision and
  // outranks the global mode — including 'block'. Losing that would silently
  // undo every "always load from this sender" the reader has ever clicked.
  it('honours the per-sender allowlist over the global mode', async () => {
    writeRemoteImageMode('block');
    await withAllowedSenders(['Boss@Acme.com']);
    // Matched case-insensitively — the allowlist stores whatever the server sent.
    expect(blockRemoteImagesFor(mail({ fromAddress: 'boss@acme.com' }))).toBe(false);
    expect(blockRemoteImagesFor(mail({ fromAddress: 'other@acme.com' }))).toBe(true);
  });

  // Regression: bubbles whose source mail is missing from the thread map (an
  // AI turn stitched from a message that has since moved) have no sender and
  // no tags. Fail safe — ask the reader — rather than treating "unknown" as
  // "allowed" and fetching from an unvetted host.
  it('blocks a bubble with no source mail, even under "always"', () => {
    writeRemoteImageMode('always');
    expect(blockRemoteImagesFor(undefined)).toBe(true);
  });
});

/** First-email facts in each shape the rules distinguish. */
const FACTS: Record<string, FirstEmailFacts> = {
  unknown: { kind: 'unknown' },
  none: { kind: 'known', asSent: false, quoteCount: 0, countSource: 'marker' },
  one: { kind: 'known', asSent: false, quoteCount: 1, countSource: 'split' },
  many: { kind: 'known', asSent: false, quoteCount: 3, countSource: 'split' },
  asSent: { kind: 'known', asSent: true, quoteCount: 0, countSource: 'split' },
};

const rules = (overrides: Partial<ChatViewRulesInput>) =>
  chatViewRulesFor({
    memberCount: 1,
    facts: FACTS.none!,
    loadingThread: false,
    selectedThreadCount: 1,
    chatViewEnabled: true,
    chatManuallyEnabled: false,
    aiAvailable: true,
    ...overrides,
  });

/**
 * THE chat-offer matrix. What breaks if this goes red: the card and the chat
 * render together (both composers, two copies of the mail), a single-quote
 * reply auto-opens as chat, a looped-in chain stays a wall of quoted text, or
 * AI is spent on mail that does not need it.
 */
describe('chatViewRulesFor', () => {
  // A thread of two or more members is a conversation, whatever its first
  // email quotes.
  it('offers and opens chat for a multi-email thread', () => {
    expect(rules({ memberCount: 3 })).toMatchObject({ offerChat: true, chatActive: true, showAiToggle: false });
  });

  // Unknown is not 0: nothing is offered yet, but nothing is decided either.
  it('offers nothing for a single email whose body has not arrived', () => {
    expect(rules({ facts: FACTS.unknown! })).toMatchObject({
      eligibility: 'unknown', offerChat: false, chatActive: false, showAiToggle: false, autoRunAI: false,
    });
  });

  it('keeps a single email that quotes nothing a card, with no chat offered', () => {
    expect(rules({ facts: FACTS.none! })).toMatchObject({ offerChat: false, chatActive: false, showAiToggle: false });
  });

  // Decision 2: one quoted message — chat OFFERED, not opened; AI on demand.
  it('offers chat for a single email quoting ONE message but keeps it a card until toggled', () => {
    expect(rules({ facts: FACTS.one! })).toMatchObject({
      eligibility: 'on_demand', offerChat: true, chatActive: false, showAiToggle: true, autoRunAI: false,
    });
    expect(rules({ facts: FACTS.one!, chatManuallyEnabled: true }).chatActive).toBe(true);
  });

  // Decision 3: two or more quoted messages — opens as chat, AI automatic.
  it('opens chat by itself for a single email quoting two or more messages', () => {
    expect(rules({ facts: FACTS.many! })).toMatchObject({
      eligibility: 'auto', offerChat: true, chatActive: true, showAiToggle: true, autoRunAI: true,
    });
  });

  // The as-sent rule replaces the old designed-HTML regex: designed bulk mail
  // is never offered chat on its own.
  it('never offers chat for as-sent bulk mail', () => {
    expect(rules({ facts: FACTS.asSent! })).toMatchObject({ eligibility: 'none', offerChat: false, chatActive: false });
    expect(rules({ facts: FACTS.asSent!, chatManuallyEnabled: true }).chatActive).toBe(false);
  });

  // While loading, chat pre-shows only when the list row already knows the
  // thread has more than one message — not for every email.
  it('pre-shows chat while loading only for a known multi-message thread', () => {
    expect(rules({ memberCount: 0, loadingThread: true, selectedThreadCount: 4, facts: FACTS.unknown! }).chatActive).toBe(true);
    expect(rules({ memberCount: 0, loadingThread: true, selectedThreadCount: 1, facts: FACTS.unknown! }).chatActive).toBe(false);
  });

  it('shows nothing active with chat view off', () => {
    expect(rules({ memberCount: 3, chatViewEnabled: false }).chatActive).toBe(false);
    expect(rules({ facts: FACTS.many!, chatViewEnabled: false }).chatActive).toBe(false);
  });

  // No provider: chat is still a Standard view, but no AI toggle and no AI.
  it('spends no AI and hides the AI toggle without a provider', () => {
    expect(rules({ facts: FACTS.many!, aiAvailable: false })).toMatchObject({
      chatActive: true, showAiToggle: false, autoRunAI: false, aiAvailable: false,
    });
    expect(rules({ facts: FACTS.many! }).aiAvailable).toBe(true);
  });

  // A usable split keeps the AI toggle even if the facts no longer ask for AI.
  it('shows the AI toggle while a usable split exists', () => {
    expect(rules({ memberCount: 3, usableSplit: true }).showAiToggle).toBe(true);
  });

  // Breaks: the AI view (and its Process now / Re-split actions, which can
  // only fail) offered without a provider or with conversation mode off
  // because a split was cached earlier. DELIBERATE (plan §5): the cached split
  // is not shown then — the reader gets Standard — and it comes back, unspent,
  // when a provider is configured again.
  it('hides the AI toggle over a usable split without a provider (or with conversation mode off)', () => {
    expect(rules({ memberCount: 3, usableSplit: true, aiAvailable: false })).toMatchObject({
      showAiToggle: false, autoRunAI: false, chatActive: true,
    });
    expect(rules({ facts: FACTS.many!, usableSplit: true, aiAvailable: false }).showAiToggle).toBe(false);
  });
});

describe('aiEligibilityFor (re-exported with the chat rules)', () => {
  it('is the same rule the chat view reads', () => {
    expect(aiEligibilityFor(FACTS.many!)).toBe('auto');
    expect(aiEligibilityFor(FACTS.one!)).toBe('on_demand');
  });
});

describe('firstSlotPromptFor', () => {
  const prompt = (overrides: Partial<Parameters<typeof firstSlotPromptFor>[0]>) =>
    firstSlotPromptFor({
      showAIView: true,
      aiAvailable: true,
      eligibility: 'auto',
      state: 'miss',
      running: false,
      autoRunAI: true,
      automaticRunAllowed: true,
      ...overrides,
    });

  it('shows nothing outside the AI view', () => {
    expect(prompt({ showAIView: false })).toBeNull();
  });

  it('invites processing when there is no split yet', () => {
    expect(prompt({ state: 'miss' })).toBe('process');
    expect(prompt({ state: 'skipped', eligibility: 'on_demand' })).toBe('process');
  });

  it('shows no invitation for an email that quotes nothing', () => {
    expect(prompt({ state: 'miss', eligibility: 'none' })).toBeNull();
    expect(prompt({ state: 'unknown' })).toBeNull();
  });

  it('shows progress while a run is in flight — over a usable split too', () => {
    expect(prompt({ running: true })).toBe('running');
    expect(prompt({ running: true, state: 'usable' })).toBe('running');
  });

  // A transient failure retries by itself; the banner says so rather than
  // looking like a dead end.
  it('says a transient failure will retry', () => {
    expect(prompt({ state: 'retry-later' })).toBe('retry');
    expect(prompt({ state: 'due' })).toBe('retry');
  });

  // …but only where automatic runs happen: a single-quote email is never
  // split unasked, so promising a retry there would be a promise nobody keeps.
  it('offers Try again, not "will retry", where no automatic run will come', () => {
    expect(prompt({ state: 'retry-later', eligibility: 'on_demand', autoRunAI: false })).toBe('failed');
    expect(prompt({ state: 'due', eligibility: 'on_demand', autoRunAI: false })).toBe('failed');
  });

  // Regression: a key the session guard stopped (its automatic runs kept
  // persisting nothing) was still told "will retry automatically" — a retry
  // the store would refuse every time. It gets Try again instead.
  it('offers Try again, not "will retry", once the session guard stopped the key', () => {
    expect(prompt({ state: 'due', automaticRunAllowed: false })).toBe('failed');
    expect(prompt({ state: 'retry-later', automaticRunAllowed: false })).toBe('failed');
    expect(prompt({ state: 'failed-retryable', automaticRunAllowed: false })).toBe('failed');
    // A run in flight (a manual one) is still shown as running.
    expect(prompt({ state: 'due', automaticRunAllowed: false, running: true })).toBe('running');
  });

  it('offers Try again for a permanent failure', () => {
    expect(prompt({ state: 'failed' })).toBe('failed');
  });

  // A 4xx under an old provider: the new provider gets one automatic try
  // where automatic runs happen; elsewhere the reader decides.
  it('treats a provider-dependent failure as retrying only where runs are automatic', () => {
    expect(prompt({ state: 'failed-retryable', autoRunAI: true })).toBe('retry');
    expect(prompt({ state: 'failed-retryable', autoRunAI: false })).toBe('failed');
  });

  // Breaks: a reader who finds the split wrong has no way to redo it, or a
  // run in flight over a usable split shows no spinner.
  it('offers a compact re-split over a usable split', () => {
    expect(prompt({ state: 'usable' })).toBe('resplit');
    expect(prompt({ state: 'usable', running: true })).toBe('running');
  });

  // Breaks: with no provider (or conversation mode off) a Re-split button is
  // offered whose only outcome is a provider failure that saves nothing. A
  // guard for any caller: the chat view itself hides the AI view without a
  // provider (showAiToggle), so it never asks.
  it('offers no re-split over a usable split without a provider', () => {
    expect(prompt({ state: 'usable', aiAvailable: false })).toBeNull();
    expect(prompt({ state: 'usable', aiAvailable: false, running: true })).toBe('running');
  });

  it('invites nothing without a provider', () => {
    expect(prompt({ aiAvailable: false })).toBeNull();
  });
});
