// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnippetLines } from '../../../../../src/appearance';
import { CompactThreadRow } from '../../../../../src/components/email-list/CompactThreadRow';
import type { ThreadRowProps } from '../../../../../src/components/email-list/types';
import { buildThreads } from '../../../../../src/utils/thread-utils';
import { emailRecord } from '../../../../helpers/email-fixtures';
import { cleanup, render, settle } from '../../../../helpers/render';

vi.mock('../../../../../src/components/email-list/CategoryBadges', () => ({
  CategoryBadges: () => <span>Promotions</span>,
  applyEmailCategories: vi.fn(),
}));

const rowProps = (snippetLines: SnippetLines): ThreadRowProps => ({
  thread: buildThreads([emailRecord({ id: 'e1', threadId: 't1', subject: 'Details', accountId: 'acct-1' })])[0]!,
  actions: {
    onThreadClick: vi.fn(),
    onToggleSelection: vi.fn(),
    onToggleStar: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onToggleRead: vi.fn(),
    onSnooze: vi.fn(),
    onUnsnooze: vi.fn(),
  },
  uiState: {
    selectedEmailId: null,
    highlightedEmailId: null,
    selectedThreadIds: new Set<string>(),
    showImportanceMarkers: false,
    viewingSnoozed: false,
    countdownTick: 0,
  },
  hoverActions: { setHoveredThreadId: vi.fn(), setSnoozeDropdownThreadId: vi.fn() },
  isHovered: false,
  showSnoozeDropdown: false,
  snippetLines,
});

beforeEach(() => {
  (window as unknown as Record<string, unknown>).electronAPI = { ai: {
    getCategoryDefinitions: vi.fn(async () => ({ success: true, data: [] })),
    getEmailCategoriesBatch: vi.fn(async () => ({ success: true, data: {} })),
  } };
});
afterEach(() => { cleanup(); delete (window as unknown as Record<string, unknown>).electronAPI; });

describe('compact category hover actions', () => {
  // Regression: category editing must share the hidden action strip instead of occupying space beside the date.
  it('keeps category controls hidden with the other actions until hover', async () => {
    const props = rowProps(0);
    const view = render(<CompactThreadRow {...props} />);
    await settle();
    const category = view.byLabel('Categories')!;
    const strip = category.closest('[aria-hidden]')!;
    expect(strip.getAttribute('aria-hidden')).toBe('true');
    expect(strip.classList.contains('invisible')).toBe(true);
    expect(strip.querySelector('[title="Archive"]')).not.toBeNull();
    view.rerender(<CompactThreadRow {...props} isHovered />);
    expect(strip.getAttribute('aria-hidden')).toBe('false');
    expect(strip.classList.contains('visible')).toBe(true);
    expect(category.classList.contains('p-1.5')).toBe(true);
  });

  // Regression: moving the pointer into a portalled menu must not unmount it with the row's hover controls.
  it('keeps the portalled menu and action strip open after leaving the row, then hides on close', async () => {
    const props = rowProps(0);
    const view = render(<CompactThreadRow {...props} isHovered />);
    await settle();
    const category = view.byLabel('Categories')!;
    const strip = category.closest('[aria-hidden]')!;
    act(() => category.click());
    await settle();
    const popup = view.byLabel('Assign categories');
    expect(popup).not.toBeNull();
    expect(view.container.contains(popup)).toBe(false);
    expect(props.actions.onThreadClick).not.toHaveBeenCalled();
    view.rerender(<CompactThreadRow {...props} isHovered={false} />);
    await settle();
    expect(view.byLabel('Assign categories')).toBe(popup);
    expect(strip.getAttribute('aria-hidden')).toBe('false');
    act(() => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await settle();
    expect(view.byLabel('Assign categories')).toBeNull();
    expect(strip.getAttribute('aria-hidden')).toBe('true');
    expect(strip.classList.contains('invisible')).toBe(true);
  });
});
