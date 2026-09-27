// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SnippetLines } from '../../../../../src/appearance';
import { CompactThreadRow } from '../../../../../src/components/email-list/CompactThreadRow';
import { SNIPPET_CHARS_PER_LINE } from '../../../../../src/components/email-list/snippet-text';
import { ThreadCard } from '../../../../../src/components/email-list/ThreadCard';
import type { ThreadRowProps } from '../../../../../src/components/email-list/types';
import { buildThreads } from '../../../../../src/utils/thread-utils';
import { emailRecord } from '../../../../helpers/email-fixtures';
import { render, settle, type Mounted } from '../../../../helpers/render';

/**
 * The body preview in a list row (Appearance -> Message list).
 *
 * What breaks if this suite goes red: "None" still prints a preview, or a row
 * hands the DOM a whole message body. Neither shows up in a unit test of
 * `snippetText` alone — the helper can be perfect and the row ignore it.
 */
const BODY_START = 'A long first line that fills the row.';
const BODY = `${BODY_START} ${'filler '.repeat(60)}`;

const thread = () =>
  buildThreads([emailRecord({ id: 'e1', threadId: 't1', subject: 'Production details', cleanBody: BODY })])[0]!;

const rowProps = (snippetLines: SnippetLines): ThreadRowProps => ({
  thread: thread(),
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

/** The rendered preview, whichever element each layout draws it in. */
const previewText = (view: Mounted): string | null =>
  [...view.container.querySelectorAll('span')]
    .map((element) => element.textContent ?? '')
    .find((text) => text.startsWith(BODY_START)) ?? null;

/** The category badges fetch definitions on mount; there is no bridge here. */
const stubBridge = () => {
  (window as unknown as Record<string, unknown>).electronAPI = {
    ai: {
      getCategoryDefinitions: async () => ({ success: true, data: [] }),
      getEmailCategoriesBatch: async () => ({ success: true, data: {} }),
    },
  };
};

describe.each([
  ['ThreadCard', ThreadCard],
  ['CompactThreadRow', CompactThreadRow],
])('%s preview', (_name, Row) => {
  let mounted: Mounted | undefined;

  beforeEach(stubBridge);
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    delete (window as unknown as Record<string, unknown>).electronAPI;
  });

  const mount = async (snippetLines: SnippetLines) => {
    mounted = render(<Row {...rowProps(snippetLines)} />);
    await settle();
    return mounted;
  };

  // THE REGRESSION: "None" has to remove the preview, not merely shorten it —
  // an empty element still takes its line height and its separator.
  it('draws no preview at all for none', async () => {
    const view = await mount(0);

    expect(previewText(view)).toBeNull();
    expect(view.container.querySelector('.list-snippet')).toBeNull();
    // The row is otherwise unchanged — the subject never depends on this.
    expect(view.container.textContent).toContain('Production details');
  });

  it('draws the preview once lines are asked for', async () => {
    const view = await mount(1);

    expect(previewText(view)).toContain(BODY_START);
  });

  // Regression: a row must not hand the DOM the whole body and leave the
  // hiding to CSS — that is layout work per row, on every render of the list.
  it('never puts the whole body in the DOM', async () => {
    const view = await mount(2);

    expect(previewText(view)!.length).toBeLessThanOrEqual(SNIPPET_CHARS_PER_LINE * 2);
  });
});

describe('the two layouts show their own number of lines', () => {
  let mounted: Mounted | undefined;
  beforeEach(stubBridge);
  afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    delete (window as unknown as Record<string, unknown>).electronAPI;
  });

  // Regression: the clamp is a CSS class reading --snippet-lines. Drop the
  // class and "2 lines" prints paragraphs into the list.
  it('clamps the card preview with .list-snippet', async () => {
    mounted = render(<ThreadCard {...rowProps(2)} />);
    await settle();

    const snippet = mounted.container.querySelector('.list-snippet');
    expect(snippet?.textContent).toContain(BODY_START);
    expect(snippet?.textContent).toHaveLength(SNIPPET_CHARS_PER_LINE * 2);
  });

  // The compact row's height is fixed by the density: it shows one line or
  // none, so "2 lines" must still give it exactly one — truncated, not clamped.
  it('keeps the compact row to a single truncated line even at two', async () => {
    mounted = render(<CompactThreadRow {...rowProps(2)} />);
    await settle();

    expect(previewText(mounted)).toHaveLength(SNIPPET_CHARS_PER_LINE);
    expect(mounted.container.querySelector('.list-snippet')).toBeNull();
    const preview = [...mounted.container.querySelectorAll('span')]
      .find((element) => element.textContent?.startsWith(BODY_START));
    expect(preview?.className).toContain('truncate');
  });
});
