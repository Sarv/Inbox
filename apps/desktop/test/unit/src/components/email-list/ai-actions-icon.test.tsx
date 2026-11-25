// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiActionsIcon, threadAiActions } from '../../../../../src/components/email-list/AiActionsIcon';
import { CompactThreadRow } from '../../../../../src/components/email-list/CompactThreadRow';
import { ThreadCard } from '../../../../../src/components/email-list/ThreadCard';
import type { ThreadRowProps } from '../../../../../src/components/email-list/types';
import { buildThreads } from '../../../../../src/utils/thread-utils';
import { emailRecord } from '../../../../helpers/email-fixtures';
import { act, render, type Mounted } from '../../../../helpers/render';

// The small AI mark on a list row: something on this conversation was done by
// the AI, and pointing at it says what.

const T = 1_795_000_000; // seconds
const action = (kind: string, offset: number, auto = true) => ({ kind, at: T + offset, auto }) as never;

let mounted: Mounted | undefined;
afterEach(() => { mounted?.unmount(); mounted = undefined; });

describe('AI actions icon', () => {
  // Breaks: rows the AI never touched, or only categorized, show the AI mark,
  // so it appears on nearly every row and means nothing.
  it('shows nothing without an action worth the icon', () => {
    mounted = render(<AiActionsIcon emails={[{}, { aiActions: [action('category', 0)] }]} />);
    expect(mounted.container.innerHTML).toBe('');
  });

  // Breaks: the tooltip lists the oldest actions, hides who decided, or
  // misses actions on other messages of the conversation.
  it('says what the AI did across the conversation, newest first, and who decided', async () => {
    const emails = [{ aiActions: [action('read', 10), action('category', 15)] }, { aiActions: [action('draft', 20, false)] }];
    expect(threadAiActions(emails).map(item => item.kind)).toEqual(['read', 'draft']);
    mounted = render(<AiActionsIcon emails={emails} />);
    const mark = mounted.find('[role="img"]')!;
    expect(mark.getAttribute('aria-label')).toBe('Done by AI: Drafted a reply, Marked as read');
    // React delivers onMouseEnter from a delegated `mouseover`, the event the shared Tooltip opens on.
    vi.useFakeTimers();
    try {
      await act(async () => { mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
      await act(async () => { vi.advanceTimersByTime(100); });
    } finally { vi.useRealTimers(); }
    const tip = document.body.textContent ?? '';
    expect(tip).toContain('Drafted a reply · you approved');
    expect(tip).toContain('Marked as read · automatically');
    expect(tip.indexOf('Drafted a reply')).toBeLessThan(tip.indexOf('Marked as read'));
  });

  // Breaks: a busy conversation's tooltip grows without end.
  it('folds all but the newest five into a count', () => {
    const emails = [{ aiActions: Array.from({ length: 7 }, (_, index) => action('star', index)) }];
    mounted = render(<AiActionsIcon emails={emails} />);
    expect(mounted.find('[role="img"]')!.getAttribute('aria-label')).toMatch(/, and 2 earlier$/);
  });
});

const rowProps = (isHovered: boolean): ThreadRowProps => ({
  thread: buildThreads([emailRecord({ id: 'e1', threadId: 't1', subject: 'Weekly deals', aiActions: [action('archive', 0)] as never })])[0]!,
  actions: {
    onThreadClick: vi.fn(), onToggleSelection: vi.fn(), onToggleStar: vi.fn(), onArchive: vi.fn(),
    onDelete: vi.fn(), onToggleRead: vi.fn(), onSnooze: vi.fn(), onUnsnooze: vi.fn(),
  },
  uiState: { selectedEmailId: null, highlightedEmailId: null, selectedThreadIds: new Set<string>(), showImportanceMarkers: false, viewingSnoozed: false, countdownTick: 0 },
  hoverActions: { setHoveredThreadId: vi.fn(), setSnoozeDropdownThreadId: vi.fn() },
  isHovered,
  showSnoozeDropdown: false,
  snippetLines: 1,
});

describe.each([
  ['ThreadCard', ThreadCard],
  ['CompactThreadRow', CompactThreadRow],
])('%s AI mark', (_name, Row) => {
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).electronAPI = {
      ai: { getCategoryDefinitions: async () => ({ success: true, data: [] }), getEmailCategoriesBatch: async () => ({ success: true, data: {} }) },
    };
  });
  afterEach(() => { delete (window as unknown as Record<string, unknown>).electronAPI; });

  // Breaks: the list never shows what the AI did, or the mark disappears
  // under the hover actions exactly when the user points at the row.
  it.each([false, true])('shows a reachable AI mark (hovered: %s)', (hovered) => {
    mounted = render(<Row {...rowProps(hovered)} />);
    const marks = [...mounted.container.querySelectorAll('[role="img"][aria-label^="Done by AI"]')];
    expect(marks.length).toBeGreaterThan(0);
    const visible = marks.filter(mark => !mark.closest('.hidden, .invisible, .pointer-events-none'));
    expect(visible).toHaveLength(1);
    expect(visible[0]!.getAttribute('aria-label')).toBe('Done by AI: Archived');
  });
});
