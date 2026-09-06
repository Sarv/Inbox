// Decision functions for the chat view. The first two are pure; the last one
// reads the reader's image settings, so this file installs a localStorage and
// an electronAPI for it.
import type { EmailRecord } from '@sarvinbox/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  blockRemoteImagesFor,
  chatSourceFor,
  shouldShowProcessPrompt,
} from '../../../../../src/components/email-detail/chat-view-rules';
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

describe('chatSourceFor', () => {
  // Regression: the AI view used to fall back to the deterministic split when
  // the pipeline had produced nothing, so both views rendered IDENTICAL
  // bubbles. The reader then cannot tell AI output from raw mail, and a thread
  // the LLM never touched looks fully processed. AI view shows AI output only.
  it('renders nothing in the AI view when no message has been extracted', () => {
    expect(chatSourceFor(true, 0)).toBe('none');
  });

  // Regression: the counterpart — once the pipeline HAS produced turns, the AI
  // view must render those and not silently keep showing the thread split.
  it('renders the extracted turns in the AI view when there are some', () => {
    expect(chatSourceFor(true, 1)).toBe('ai');
    expect(chatSourceFor(true, 12)).toBe('ai');
  });

  // Regression: Standard is the view that always has content. If it ever
  // started depending on the AI pipeline, an unprocessed thread would have
  // nowhere left to show its mail at all.
  it('always renders the thread split in Standard, extracted or not', () => {
    expect(chatSourceFor(false, 0)).toBe('thread');
    expect(chatSourceFor(false, 5)).toBe('thread');
  });
});

describe('shouldShowProcessPrompt', () => {
  const base = {
    showAIView: true,
    extractionInFlight: false,
    conversationLoading: false,
    renderedCount: 0,
  };

  // Regression: with nothing extracted and nothing running, the AI view must
  // offer the extraction. Gating this on `conversationPartial` (as it was)
  // hid the prompt for threads the pipeline had never touched, which is
  // exactly the case that most needs it.
  it('offers the extraction when the AI view is empty and idle', () => {
    expect(shouldShowProcessPrompt(base)).toBe(true);
  });

  // Regression: inviting the user to start an extraction that is already
  // running produces duplicate LLM work and a confusing double spinner.
  it('stays hidden while an extraction is in flight', () => {
    expect(shouldShowProcessPrompt({ ...base, extractionInFlight: true })).toBe(false);
  });

  // Regression: the stored conversation loads asynchronously. Prompting during
  // that window makes an already-processed thread look unprocessed, and one
  // click throws away a good extraction to redo it.
  it('stays hidden while the stored conversation is still loading', () => {
    expect(shouldShowProcessPrompt({ ...base, conversationLoading: true })).toBe(false);
  });

  // Regression: the prompt replaces the bubbles, so showing it with messages
  // on screen would hide real content behind an invitation.
  it('stays hidden once anything is rendered', () => {
    expect(shouldShowProcessPrompt({ ...base, renderedCount: 1 })).toBe(false);
  });

  // Regression: Standard has no extraction to offer — the prompt there would
  // be an AI affordance on a view that is deliberately AI-free.
  it('never appears in Standard view', () => {
    expect(shouldShowProcessPrompt({ ...base, showAIView: false })).toBe(false);
    expect(
      shouldShowProcessPrompt({ ...base, showAIView: false, conversationLoading: true }),
    ).toBe(false);
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
