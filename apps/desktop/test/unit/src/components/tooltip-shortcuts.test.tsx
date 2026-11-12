// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Tooltip } from '../../../../src/components/Tooltip';
import { act, cleanup, render } from '../../../helpers/render';

/**
 * The keyboard hints a Tooltip shows beside its label: one string, a list
 * ("or" between them), or none.
 *
 * What breaks if this file goes red: a control's shortcut stops being shown on
 * hover, an empty entry renders as a blank key cap, or a tooltip with no label
 * and no shortcut pops up as an empty bubble.
 */

const hoverAndRead = async (shortcut: string | string[] | undefined, content: string | null = 'Archive') => {
  const mounted = render(<Tooltip content={content} shortcut={shortcut} delayMs={10}><button>x</button></Tooltip>);
  await act(async () => {
    mounted.container.firstElementChild!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await act(async () => { vi.advanceTimersByTime(50); });
  const bubble = mounted.find('div.fixed');
  return { bubble, keys: mounted.all('kbd').map((k) => k.textContent) };
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Tooltip shortcuts', () => {
  // Breaks: a control's one shortcut is no longer shown on hover.
  it('shows a single shortcut', async () => {
    expect((await hoverAndRead('E')).keys).toEqual(['E']);
  });

  // Breaks: alternative shortcuts collapse to one, or an empty entry renders a blank key cap.
  it('shows every non-empty shortcut of a list, joined by "or"', async () => {
    const { bubble, keys } = await hoverAndRead(['E', '', 'Shift+E']);
    expect(keys).toEqual(['E', 'Shift+E']);
    expect(bubble?.textContent).toContain('or');
  });

  // Breaks: a control with no shortcut shows an empty key cap.
  it('shows no key cap for an empty or missing shortcut', async () => {
    expect((await hoverAndRead('')).keys).toEqual([]);
    cleanup();
    expect((await hoverAndRead(undefined)).keys).toEqual([]);
    cleanup();
    expect((await hoverAndRead([])).keys).toEqual([]);
  });

  // Breaks: a tooltip with nothing to say pops up as an empty bubble.
  it('shows no bubble at all with neither a label nor a shortcut', async () => {
    expect((await hoverAndRead(undefined, null)).bubble).toBeNull();
  });
});
