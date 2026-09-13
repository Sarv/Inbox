// Give a table that is wider than the message its own horizontal scrollbar.
//
// The iframe body clips (`overflow-x: hidden`) so one wide child can't push a
// scrollbar onto the whole message. Chat View pays for that by restructuring
// every table (`display: block; overflow-x: auto`), but the Standard view
// deliberately leaves the sender's table layout alone — marketing mail is built
// out of table shells that `display: block` would take apart. The result was a
// pasted spreadsheet losing its right-hand columns with no way to reach them.
//
// So the scroll comes from a wrapper AROUND the table instead of from the table
// itself, and only around tables that are MEASURED to overflow — a fact, not a
// data-table-vs-layout-shell guess.

/** Marks a wrapper this module owns, so re-running is a no-op. */
export const TABLE_SCROLL_CLASS = 'sarv-table-scroll';

/** The wrapper's styling, injected into the iframe's stylesheet. */
export const TABLE_SCROLL_CSS = `.${TABLE_SCROLL_CLASS} { max-width: 100%; overflow-x: auto; }`;

/**
 * Wrap every top-level table in `doc` that is wider than the body.
 *
 * Idempotent: a table already inside one of our wrappers is skipped, so this is
 * safe to call from a measurement loop that a MutationObserver drives. Nested
 * tables are skipped too — they scroll with the outermost table they sit in,
 * and wrapping both would nest two scroll regions inside each other.
 */
export function wrapOverflowingTables(doc: Document): void {
  const available = doc.body?.clientWidth ?? 0;
  // Before first layout (or while the pane is collapsed) every width reads 0
  // and every table would look like it overflows. Do nothing and let the next
  // measurement decide.
  if (available <= 0) return;

  for (const table of Array.from(doc.querySelectorAll('table'))) {
    const parent = table.parentElement;
    if (!parent) continue;
    if (parent.classList.contains(TABLE_SCROLL_CLASS)) continue;
    if (parent.closest('table')) continue;
    // +1px of slack: a table sized to exactly the body rounds to a fraction
    // either way, and a scrollbar on a table that fits is worse than none.
    if (table.getBoundingClientRect().width <= available + 1) continue;

    const wrapper = doc.createElement('div');
    wrapper.className = TABLE_SCROLL_CLASS;
    parent.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }
}
