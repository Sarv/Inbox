// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConversationTab,
  clearCacheOutcome,
} from '../../../../../../src/components/settings/ai/ConversationTab';
import type { AIProvider } from '../../../../../../src/services/ai-service';
import { render, settle, toggle, fire, act } from '../../../../../helpers/render';

// The tab maps the failed account ids main reports to the addresses this
// window knows. Only `accounts` is read, through a selector.
const ACCOUNTS = [
  { id: 'acct-a', email: 'alice@work.example' },
  { id: 'acct-b', email: 'alice@home.example' },
];
vi.mock('../../../../../../src/store/email-store', () => ({
  useEmailStore: (selector: (state: { accounts: typeof ACCOUNTS }) => unknown) => selector({ accounts: ACCOUNTS }),
}));

const PROVIDER = { id: 'p1', type: 'openai', name: 'OpenAI', apiKey: 'test', model: 'm', isDefault: true } as unknown as AIProvider;
const AI_FEATURES_KEY = 'sarvinbox-ai-features';

let setBackgroundSplitEnabled: ReturnType<typeof vi.fn>;
let clearAllFirstSplits: ReturnType<typeof vi.fn>;
let clearAllConversations: ReturnType<typeof vi.fn>;
let confirmSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  setBackgroundSplitEnabled = vi.fn(async () => ({ success: true }));
  clearAllFirstSplits = vi.fn(async () => ({ success: true, data: { cleared: 4, splits: 4, failedAccounts: [] } }));
  // The retired single-account IPC: present here only so a regression back to it is caught.
  clearAllConversations = vi.fn(async () => ({ success: true, data: 9 }));
  confirmSpy = vi.fn(() => true);
  vi.stubGlobal('confirm', confirmSpy);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    ai: { setBackgroundSplitEnabled, clearAllFirstSplits, clearAllConversations },
  };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  document.body.innerHTML = '';
  localStorage.clear();
});

/** The three switches, in page order: conversation mode, auto chat view, auto chat extract. */
const switches = (view: ReturnType<typeof render>) => view.all('input[type="checkbox"]') as HTMLInputElement[];
const clearButton = (view: ReturnType<typeof render>) =>
  view.all('button').find((button) => button.textContent?.includes('Clear Cache')) ?? null;
const status = (view: ReturnType<typeof render>) => view.find('[role="status"]')?.textContent ?? null;
const stored = (): Array<{ id: string; enabled: boolean }> => JSON.parse(localStorage.getItem(AI_FEATURES_KEY) || '[]');
const storedEnabled = (id: string) => stored().find((feature) => feature.id === id)?.enabled;

// What breaks if this suite goes red: main's first-split scheduler keeps the
// switch it was told at startup. A toggle that does not push it leaves main
// scanning every account every 45 s (and cooling refs down) after the reader
// switched the background split off — or never nominating after they switched
// it back on, until the next restart.
describe('ConversationTab pushes the background-split switch to main', () => {
  it('on toggling Auto Chat Extract off and on again', async () => {
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    expect(switches(view)).toHaveLength(3);

    toggle(switches(view)[2]!);
    await settle();
    expect(setBackgroundSplitEnabled).toHaveBeenLastCalledWith(false);

    toggle(switches(view)[2]!);
    await settle();
    expect(setBackgroundSplitEnabled).toHaveBeenLastCalledWith(true);
    view.unmount();
  });

  // Conversation mode off switches the background split off too, even while
  // 'Auto Chat Extract' itself was on — the last push must say off.
  it('on turning conversation mode off', async () => {
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    toggle(switches(view)[0]!);
    await settle();
    expect(setBackgroundSplitEnabled).toHaveBeenCalled();
    expect(setBackgroundSplitEnabled).toHaveBeenLastCalledWith(false);
    view.unmount();
  });
});

describe('ConversationTab — the conversation-mode cascade', () => {
  // Breaks: conversation mode off while Auto Chat View / Auto Chat Extract stay
  // stored ON — the sub-switches vanish from the page but keep acting (a thread
  // auto-opening in chat, a background split spending AI) with no visible
  // switch left to turn them off.
  it('turning conversation mode off turns both sub-toggles off, and on again leaves them off', async () => {
    localStorage.setItem(AI_FEATURES_KEY, JSON.stringify([
      { id: 'conversation-mode', enabled: true },
      { id: 'auto-chat-view', enabled: true },
      { id: 'auto-chat-extract', enabled: true },
    ]));
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    expect(switches(view).map((input) => input.checked)).toEqual([true, true, true]);

    toggle(switches(view)[0]!);
    await settle();
    expect(switches(view)).toHaveLength(1); // the sub-cards hide with the mode
    expect(storedEnabled('conversation-mode')).toBe(false);
    expect(storedEnabled('auto-chat-view')).toBe(false);
    expect(storedEnabled('auto-chat-extract')).toBe(false);

    toggle(switches(view)[0]!);
    await settle();
    expect(switches(view).map((input) => input.checked)).toEqual([true, false, false]);
    view.unmount();
  });

  // Breaks: a switch that renders its stored state wrong — the reader turns
  // Auto Chat View on, reopens Settings and finds it off (or the reverse).
  it('renders each switch from its stored state', async () => {
    localStorage.setItem(AI_FEATURES_KEY, JSON.stringify([
      { id: 'conversation-mode', enabled: true },
      { id: 'auto-chat-view', enabled: true },
      { id: 'auto-chat-extract', enabled: false },
    ]));
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    expect(switches(view).map((input) => input.checked)).toEqual([true, true, false]);

    toggle(switches(view)[1]!);
    await settle();
    expect(storedEnabled('auto-chat-view')).toBe(false);
    view.unmount();
  });

  // Breaks: a stored list written before a switch existed (only conversation
  // mode saved) losing the other switches' defaults, or a later toggle of one
  // of them never being saved because the list had no entry to update.
  it('keeps the defaults for switches the stored list lacks, and saves them when toggled', async () => {
    localStorage.setItem(AI_FEATURES_KEY, JSON.stringify([{ id: 'conversation-mode', enabled: true }]));
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    expect(switches(view).map((input) => input.checked)).toEqual([true, false, true]);

    toggle(switches(view)[1]!);
    await settle();
    expect(storedEnabled('auto-chat-view')).toBe(true);

    // Extract already off: turning the mode off saves only what is still on.
    toggle(switches(view)[2]!);
    await settle();
    toggle(switches(view)[0]!);
    await settle();
    expect(stored().map((feature) => [feature.id, feature.enabled])).toEqual([
      ['conversation-mode', false],
      ['auto-chat-view', false],
      ['auto-chat-extract', false],
    ]);
    view.unmount();
  });

  // Breaks: unreadable stored features crashing the tab instead of falling
  // back to the defaults (and the failure going to raw console).
  it('falls back to the defaults when the stored features are unreadable', async () => {
    localStorage.setItem(AI_FEATURES_KEY, '{not json');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    expect(switches(view).map((input) => input.checked)).toEqual([true, false, true]);
    expect(consoleError.mock.calls.some((call) => String(call[0]).startsWith('Failed to parse AI features'))).toBe(false);
    consoleError.mockRestore();
    view.unmount();
  });

  // Breaks: the switches being usable with no provider to run them.
  it('disables every switch without an AI provider and says why', async () => {
    const view = render(<ConversationTab aiProviders={[]} />);
    await settle();
    expect(switches(view).every((input) => input.disabled)).toBe(true);
    expect(view.container.textContent).toContain('No AI Provider Configured');
    view.unmount();
  });
});

describe('ConversationTab — Clear Cache covers every account', () => {
  // Breaks: Clear Cache going back to the retired single-account IPC — it then
  // clears only the active account while saying the cache is empty.
  it('calls the all-accounts first-split IPC, never the retired one, and reports the count', async () => {
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    fire(clearButton(view), 'click');
    await settle();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(clearAllFirstSplits).toHaveBeenCalledTimes(1);
    expect(clearAllConversations).not.toHaveBeenCalled();
    expect(status(view)).toBe('Cleared 4 saved splits.');
    expect(clearButton(view)!.hasAttribute('disabled')).toBe(false);
    view.unmount();
  });

  // Breaks: an account main could not clear folded into the count — "Cleared
  // 4" reads as done while that account's splits are all still there.
  it('names each account that could not be cleared, by address when known', async () => {
    clearAllFirstSplits.mockResolvedValueOnce({
      success: true,
      data: { cleared: 1, splits: 1, failedAccounts: ['acct-b', 'acct-gone'] },
    });
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    fire(clearButton(view), 'click');
    await settle();
    expect(status(view)).toBe('Cleared 1 saved split. Could not clear alice@home.example, acct-gone — try again.');
    view.unmount();
  });

  // Breaks: a failure message timing out like a success, so the reader who
  // looked away never learns an account still holds its splits.
  it('keeps a failure on screen, while a success clears after a few seconds', async () => {
    vi.useFakeTimers();
    clearAllFirstSplits.mockResolvedValueOnce({ success: true, data: { cleared: 0, splits: 0, failedAccounts: ['acct-a'] } });
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    fire(clearButton(view), 'click');
    await settle();
    expect(status(view)).toContain('Could not clear alice@work.example');
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(status(view)).toContain('Could not clear alice@work.example');

    fire(clearButton(view), 'click');
    await settle();
    expect(status(view)).toBe('Cleared 4 saved splits.');
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(status(view)).toBeNull();
    view.unmount();
  });

  // Breaks: an IPC failure (main could not read the account list) shown as a
  // success, or leaving the button stuck disabled with a spinner.
  it('reports a failed or throwing IPC and re-enables the button', async () => {
    clearAllFirstSplits.mockResolvedValueOnce({ success: false, error: 'Could not read the account list: EACCES' });
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    fire(clearButton(view), 'click');
    await settle();
    expect(status(view)).toBe('Could not clear the cache: Could not read the account list: EACCES');

    clearAllFirstSplits.mockRejectedValueOnce(new Error('bridge gone'));
    fire(clearButton(view), 'click');
    await settle();
    expect(status(view)).toBe('Could not clear the cache: bridge gone');
    expect(clearButton(view)!.hasAttribute('disabled')).toBe(false);
    view.unmount();
  });

  // Breaks: the first click's "hide" timer still running after a second
  // click — the second result vanishes early, before it could be read.
  it('restarts the hide timer on a second click', async () => {
    vi.useFakeTimers();
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    fire(clearButton(view), 'click');
    await settle();
    await act(async () => { vi.advanceTimersByTime(2_000); });
    clearAllFirstSplits.mockResolvedValueOnce({ success: true, data: { cleared: 0, splits: 0, failedAccounts: [] } });
    fire(clearButton(view), 'click');
    await settle();
    await act(async () => { vi.advanceTimersByTime(2_000); });
    expect(status(view)).toBe('Cleared 0 saved splits.');
    await act(async () => { vi.advanceTimersByTime(1_000); });
    expect(status(view)).toBeNull();
    view.unmount();
  });

  // Breaks: a bridge that answers nothing at all read as a success.
  it('reports a missing answer as a failure', async () => {
    clearAllFirstSplits.mockResolvedValueOnce(undefined);
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    fire(clearButton(view), 'click');
    await settle();
    expect(status(view)).toBe('Could not clear the cache.');
    view.unmount();
  });

  // Breaks: the caption promising a re-split "when you open it in the AI
  // view" — the automatic run starts whenever the thread is open in Chat View
  // (either half), and an email quoting a single message is only split when
  // the reader presses Process now. Copy that contradicts the code sends the
  // reader looking for a run that never comes.
  it('describes when a cleared conversation is split again as the code does it', async () => {
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    const text = view.container.textContent ?? '';
    expect(text).toContain('in the background, or when you open it in Chat View');
    expect(text).toContain('An email that quotes a single message waits for Process now.');
    expect(text).not.toContain('open it in the AI view');
    view.unmount();
  });

  // Breaks: the destructive action running when the reader pressed Cancel.
  it('does nothing when the reader cancels the confirmation', async () => {
    confirmSpy.mockReturnValueOnce(false);
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    fire(clearButton(view), 'click');
    await settle();
    expect(clearAllFirstSplits).not.toHaveBeenCalled();
    expect(status(view)).toBeNull();
    view.unmount();
  });

  // Breaks: a pending "hide the result" timer firing into an unmounted tab.
  it('drops its pending timer on unmount', async () => {
    vi.useFakeTimers();
    const view = render(<ConversationTab aiProviders={[PROVIDER]} />);
    await settle();
    fire(clearButton(view), 'click');
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('clearCacheOutcome', () => {
  const addressOf = (id: string) => (id === 'acct-a' ? 'alice@work.example' : id);

  // Breaks: a missing answer (no bridge, a dropped reply) read as "0 cleared".
  it('treats a missing or unsuccessful answer as a failure, never as a count', () => {
    expect(clearCacheOutcome(undefined, addressOf)).toEqual({ text: 'Could not clear the cache.', failed: true });
    expect(clearCacheOutcome({ success: true }, addressOf)).toEqual({ text: 'Could not clear the cache.', failed: true });
    expect(clearCacheOutcome({ success: false }, addressOf)).toEqual({ text: 'Could not clear the cache.', failed: true });
  });

  it('counts in the singular and plural', () => {
    expect(clearCacheOutcome({ success: true, data: { cleared: 1, splits: 1, failedAccounts: [] } }, addressOf).text).toBe('Cleared 1 saved split.');
    expect(clearCacheOutcome({ success: true, data: { cleared: 0, splits: 0, failedAccounts: [] } }, addressOf))
      .toEqual({ text: 'Cleared 0 saved splits.', failed: false });
  });

  // Breaks: "Cleared 1,200 saved splits" after normal use — the rows main
  // removed include the scheduler's `skipped` bookkeeping for every thread
  // without quoted history; only the ok/partial rows were ever splits.
  it('reports the saved splits, not every bookkeeping row that was removed', () => {
    expect(clearCacheOutcome({ success: true, data: { cleared: 1_200, splits: 3, failedAccounts: [] } }, addressOf))
      .toEqual({ text: 'Cleared 3 saved splits.', failed: false });
  });
});
