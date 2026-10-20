// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, cleanup, render } from '../../../helpers/render';
import { ELEVEN_AM, email, TEN_AM } from '../components/email-detail/email-fixture';

/**
 * Which message the popup Reply all (Shift+A) and Forward (Shift+F) shortcuts
 * answer in a conversation.
 *
 * What breaks if this file goes red: the shortcut answers the row that opened
 * the thread — often its first unread, i.e. an OLDER message — so the popup
 * quotes and addresses that one, while the toolbar's buttons and the inline
 * shortcuts answer the newest.
 */

const FIRST = email({ id: 'm1', date: TEN_AM });
const LATEST = email({ id: 'm9', date: ELEVEN_AM });

const storeState = {
  selectedEmailId: 'm1' as string | null,
  highlightedEmailId: null as string | null,
  threadEmails: [LATEST, FIRST],
  emails: [FIRST, LATEST],
  searchResults: [],
  searchQuery: '',
  folders: [],
  openCompose: vi.fn(),
  getNavigationThreads: () => [],
};
vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: { getState: () => storeState },
}));

const { useKeyboardShortcuts } = await import('../../../../src/hooks/useKeyboardShortcuts');

function Harness() {
  useKeyboardShortcuts({ setActiveSection: vi.fn(), focusSearch: vi.fn() });
  return null;
}

const press = (key: string) =>
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true }));
  });

afterEach(() => {
  cleanup();
  storeState.openCompose.mockReset();
  storeState.selectedEmailId = 'm1';
  storeState.threadEmails = [LATEST, FIRST];
});

describe('useKeyboardShortcuts — popup Reply all / Forward target', () => {
  // THE regression: the open thread was opened on its first message.
  it.each([
    ['A', 'replyAll'],
    ['F', 'forward'],
  ] as const)('Shift+%s answers the latest message of the open conversation', (key, mode) => {
    render(<Harness />);
    press(key);
    expect(storeState.openCompose.mock.calls).toEqual([[mode, expect.objectContaining({ id: 'm9' })]]);
  });

  // Breaks: a lone message (no thread loaded) gets no popup at all.
  it('answers the selected message when it has no conversation', () => {
    storeState.threadEmails = [];
    render(<Harness />);
    press('F');
    expect(storeState.openCompose.mock.calls).toEqual([['forward', expect.objectContaining({ id: 'm1' })]]);
  });

  // Breaks: a shortcut with nothing selected opens an empty forward.
  it('does nothing with no message selected', () => {
    storeState.selectedEmailId = null;
    render(<Harness />);
    press('F');
    expect(storeState.openCompose).not.toHaveBeenCalled();
  });
});
