// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { TABLE_SCROLL_CLASS, wrapOverflowingTables } from '../../../../src/utils/wide-table-scroll';

// happy-dom has no layout engine, so every width is 0. These stubs stand in for
// the one measurement the module makes: how wide the table renders versus how
// much room the message body has.

function setBodyWidth(width: number): void {
  Object.defineProperty(document.body, 'clientWidth', { value: width, configurable: true });
}

function setTableWidth(table: Element, width: number): void {
  table.getBoundingClientRect = () => ({ width, height: 0, top: 0, left: 0,
    right: width, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

/** Render `html` into the body and declare how wide each table measures. */
function render(html: string, widths: number[]): HTMLTableElement[] {
  document.body.innerHTML = html;
  const tables = Array.from(document.querySelectorAll('table'));
  tables.forEach((table, i) => setTableWidth(table, widths[i] ?? 0));
  return tables;
}

const wrappers = () => document.querySelectorAll(`.${TABLE_SCROLL_CLASS}`);

beforeEach(() => {
  document.body.innerHTML = '';
  setBodyWidth(600);
});

describe('wrapOverflowingTables', () => {
  // Regression: the iframe body clips (overflow-x: hidden), so a pasted
  // spreadsheet wider than the reading pane simply lost its right-hand columns
  // — no scrollbar, no indication anything was missing.
  it('wraps a table wider than the message so it can scroll', () => {
    const [table] = render('<p>Team,</p><table><tr><td>a</td></tr></table>', [1400]);

    wrapOverflowingTables(document);

    expect(table.parentElement?.className).toBe(TABLE_SCROLL_CLASS);
    // Still where the sender put it, after the paragraph.
    expect(document.body.children[1]).toBe(table.parentElement);
  });

  // Regression: marketing mail is built out of table shells that FIT. Wrapping
  // those would put a scroll container around the whole email layout.
  it('leaves a table that fits alone', () => {
    render('<table><tr><td>a</td></tr></table>', [580]);

    wrapOverflowingTables(document);

    expect(wrappers()).toHaveLength(0);
  });

  // A table sized to exactly the body rounds a fraction either way; a scrollbar
  // on a table that fits is worse than no scrollbar at all.
  it('does not wrap a table that matches the body width', () => {
    render('<table><tr><td>a</td></tr></table>', [600]);

    wrapOverflowingTables(document);

    expect(wrappers()).toHaveLength(0);
  });

  // Regression: this runs from the measurement loop, which a MutationObserver
  // re-triggers on the very mutation this makes. Without the guard each pass
  // would add another wrapper, forever.
  it('is idempotent across repeated measurements', () => {
    const [table] = render('<table><tr><td>a</td></tr></table>', [1400]);

    wrapOverflowingTables(document);
    wrapOverflowingTables(document);
    wrapOverflowingTables(document);

    expect(wrappers()).toHaveLength(1);
    expect(table.parentElement?.className).toBe(TABLE_SCROLL_CLASS);
  });

  // Regression: a data table nested in a layout shell would get its own scroll
  // region inside the shell's, so the user scrolls one and the other moves.
  // Only the outermost table scrolls.
  it('skips a table nested inside another table', () => {
    render(
      '<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>',
      [1400, 1400],
    );

    wrapOverflowingTables(document);

    expect(wrappers()).toHaveLength(1);
    expect(document.body.firstElementChild?.className).toBe(TABLE_SCROLL_CLASS);
  });

  // Before first layout — and while the pane is collapsed — every width reads
  // 0, which would make every table look like it overflows. Doing nothing lets
  // the next measurement decide instead of wrapping the entire email.
  it('does nothing before the body has been laid out', () => {
    render('<table><tr><td>a</td></tr></table>', [1400]);
    setBodyWidth(0);

    wrapOverflowingTables(document);

    expect(wrappers()).toHaveLength(0);
  });

  // A thread message can carry several pasted ranges; the narrow ones must stay
  // untouched while the wide ones scroll.
  it('wraps only the tables that overflow', () => {
    const [wide, narrow] = render(
      '<table id="w"><tr><td>a</td></tr></table><table id="n"><tr><td>b</td></tr></table>',
      [1400, 400],
    );

    wrapOverflowingTables(document);

    expect(wide.parentElement?.className).toBe(TABLE_SCROLL_CLASS);
    expect(narrow.parentElement).toBe(document.body);
  });
});
