// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, render, type Mounted } from '../../../../helpers/render';

import { email, TEN_AM } from './email-fixture';

/**
 * The keyboard hints in the toolbar's Reply and Reply all tooltips.
 *
 * What breaks if this file goes red: a tooltip teaches the wrong key. The Reply
 * button listed reply ALL's popup keys (Shift+R / Shift+A) as its own "popup"
 * variant — pressed for the reply to the sender it promised, they opened a
 * reply to everyone, and the mail went to people the reader meant to leave out.
 */

// Children the toolbar merely composes; the real ones open popovers, list
// folders and labels, or reach for IPC.
vi.mock('../../../../../src/components/email-list/SnoozeDropdown', () => ({ SnoozeDropdown: () => null }));
vi.mock('../../../../../src/components/FolderPicker', () => ({ FolderPicker: () => null }));
vi.mock('../../../../../src/components/LabelMenu', () => ({ LabelMenu: () => null }));
/** The toolbar's three-dot menu props, as it last drew them. */
const menuProps: { current?: Record<string, () => void> } = {};
vi.mock('../../../../../src/components/email-detail/EmailMenu', () => ({
  EmailMenu: (props: Record<string, () => void>) => {
    menuProps.current = props;
    return null;
  },
}));
const storeState = {
  labels: [] as { name: string }[],
  selectedFolderId: 'INBOX',
  moveEmailToFolder: vi.fn(),
  copyEmailToFolder: vi.fn(),
  viewAccountId: null,
  clearSelectedEmail: vi.fn(),
};
vi.mock('../../../../../src/store/email-store', () => ({
  useEmailStore: Object.assign(
    (select: (state: typeof storeState) => unknown) => select(storeState),
    { getState: () => storeState },
  ),
}));

const { EmailToolbar } = await import('../../../../../src/components/email-detail/EmailToolbar');

/** The toolbar's context; every flag it branches on spelled out (the Proxy's
 *  fallback is a `vi.fn()`, which is truthy). */
const context = (overrides: Record<string, unknown> = {}) =>
  new Proxy(
    {
      displayEmail: email({ id: 'm1', date: TEN_AM }),
      isRead: true,
      isInTrash: false,
      isInSpam: false,
      isRestoring: false,
      viewingAICategory: null,
      aiBoxActiveTab: null,
      hasNextEmail: false,
      hasPreviousEmail: false,
      currentEmailPosition: 0,
      totalEmailCount: 0,
      ...overrides,
    } as Record<string, unknown>,
    { get: (target, key) => (key in target ? target[key as string] : vi.fn()) },
  ) as never;

let mounted: Mounted | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  menuProps.current = undefined;
  vi.useRealTimers();
});

/** Hover the toolbar button named `name`; the keys its tooltip shows. */
const hintsFor = (name: string) => {
  vi.useFakeTimers();
  mounted = render(<EmailToolbar ctx={context()} />);
  act(() => {
    mounted!.byLabel(name)!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  act(() => {
    vi.advanceTimersByTime(40);
  });
  const tip = mounted.all('.fixed').find((el) => el.firstElementChild?.textContent === name);
  expect(tip).toBeDefined();
  return [...tip!.querySelectorAll('kbd')].map((kbd) => kbd.textContent);
};

describe('EmailToolbar — reply shortcut hints', () => {
  // THE regression: Reply showed "Shift+R popup" / "Shift+A popup".
  it('shows Reply its own key and no popup variant', () => {
    expect(hintsFor('Reply')).toEqual(['1']);
  });

  // Unchanged, pinned: Reply all keeps its inline keys, then its popup keys.
  it('shows Reply all its inline keys, then its popup keys marked as such', () => {
    expect(hintsFor('Reply all')).toEqual(['r', 'a', 'Shift+R popup', 'Shift+A popup']);
  });
});

describe('EmailToolbar — the three-dot menu', () => {
  // Regression guard for the shared menu wiring: the toolbar acts on the
  // conversation, like its own Delete and Archive buttons. Its menu forwards in
  // the popup and removes the whole thread — as before the wiring was shared.
  it('forwards in the popup and removes the whole conversation', () => {
    const h = {
      handleForward: vi.fn(),
      handleInlineForward: vi.fn(),
      handleDelete: vi.fn(),
      handleArchive: vi.fn(),
      deleteEmail: vi.fn(),
      archiveEmail: vi.fn(),
    };
    mounted = render(<EmailToolbar ctx={context(h)} />);
    const menu = menuProps.current!;

    menu.onForward();
    menu.onDelete();
    menu.onArchive();

    expect(h.handleForward.mock.calls).toEqual([[expect.objectContaining({ id: 'm1' })]]);
    expect(h.handleInlineForward).not.toHaveBeenCalled();
    expect(h.handleDelete).toHaveBeenCalledTimes(1);
    expect(h.handleArchive).toHaveBeenCalledTimes(1);
    expect(h.deleteEmail).not.toHaveBeenCalled();
    expect(h.archiveEmail).not.toHaveBeenCalled();
  });
});
