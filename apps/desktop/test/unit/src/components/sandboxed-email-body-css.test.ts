import { describe, expect, it } from 'vitest';

import { buildIframeCss } from '../../../../src/components/SandboxedEmailBody';

// The frame's stylesheet is built from four flags, and the flags are how one
// component serves three different pages:
//
//   normalize=false, transparentCanvas=false — the Standard reading pane, on a
//     forced white canvas, which is the page the mail was written for;
//   normalize=false, transparentCanvas=true  — a chat bubble carrying the
//     sender's identity colour, with the sender's own layout left intact;
//   normalize=true                            — a chat bubble whose typography
//     and tables are restructured.
//
// Which rules reach which page is the part that has actually been got wrong,
// and it cannot be reached through the component — jsdom neither lays out nor
// renders `srcdoc`.

const standard = (isDark = false) => buildIframeCss(isDark, false, false, false);
const tintedBubble = (isDark = false) => buildIframeCss(isDark, false, false, true);
const normalizedBubble = (isDark = false) => buildIframeCss(isDark, false, true, false);

describe('the editor-paper rule', () => {
  // Regression: THE white-slab bug. Word and Outlook stamp `background:white`
  // onto ordinary paragraphs and wrappers. On a bubble carrying the sender's
  // colour that lands as an opaque white block over PART of the message, so one
  // mail reads as two different backgrounds. `fitDocumentSurfaces` marks those
  // wrappers; without this rule the mark does nothing.
  it('reaches every page whose canvas is transparent', () => {
    expect(tintedBubble()).toContain('.sec-paper{background-color:transparent!important;}');
    expect(normalizedBubble()).toContain('.sec-paper{background-color:transparent!important;}');
  });

  // Regression: the Standard pane forces a WHITE canvas, so the message is
  // already on the page it was written for and there is no slab. Blanking the
  // sender's backgrounds there would strip a designed newsletter's own white
  // card down to nothing for no gain at all.
  it('stays off the forced white canvas', () => {
    expect(standard()).not.toContain('sec-paper');
    expect(standard()).not.toContain('sec-table-sheet');
  });
});

describe('the table-sheet rule', () => {
  // Regression: a ruled data table is DRAWN as a sheet of paper with lines on
  // it. Once the paper rule above has let the bubble's tint run under the whole
  // message, a grid whose rows have gone that colour too stops reading as a
  // table — so the sheet goes back under it and its plain rows read white.
  it('puts an opaque page back under a ruled grid', () => {
    expect(tintedBubble()).toContain(
      '.sec-table-sheet tr:not([bgcolor]):not([style*="background"])'
        + '{background-color:rgb(255, 255, 255);}',
    );
  });

  // CHANGED BEHAVIOUR (was: the rule sat on `.sec-table-sheet`, the table's own
  // box). A table box is a rectangle and the grid inside it need not fill one,
  // so paper under the box showed through as white with no rule around it — in
  // the slot where a Word table's last row is a cell short, and beside a
  // `display:block` table stretched past its own columns, which is every table
  // in the normalized bubble.
  it('paints the rows rather than the box they sit in', () => {
    expect(tintedBubble()).not.toContain('.sec-table-sheet{');
    expect(normalizedBubble()).not.toContain('.sec-table-sheet{');
  });

  // Regression: the cells must stay transparent so the row's paper shows
  // through them. Painting the cells put an opaque white square over the
  // sender's own `bgcolor` on a cell — a presentational hint, which loses to
  // any author rule — and over the colour of a row behind cells that declared
  // nothing.
  it('leaves the cells to the sender', () => {
    expect(tintedBubble()).not.toContain('.sec-table-sheet td');
    expect(tintedBubble()).not.toContain('.sec-table-sheet th');
  });

  // Regression: the sheet is the OPAQUE sibling of the cell wash and has to
  // follow the theme with it. A hard-coded white here would print a white slab
  // into a dark-mode bubble — the same bug, in the other direction.
  it('follows the theme into dark mode', () => {
    expect(tintedBubble(true)).toContain(
      '.sec-table-sheet tr:not([bgcolor]):not([style*="background"])'
        + '{background-color:rgb(17, 24, 39);}',
    );
    expect(tintedBubble(true)).toContain('rgba(17, 24, 39, 0.62)');
  });

  // Regression: the sheet must NOT be `!important` — it is a page put UNDER the
  // sender's design, so a banner cell's inline colour has to keep winning over
  // it. The paper rule next to it is the one exception.
  it('lets a cell that declared a colour outrank it', () => {
    const sheetRule = /\.sec-table-sheet tr[^{]*\{[^}]*\}/.exec(tintedBubble())?.[0] ?? '';
    expect(sheetRule).not.toBe('');
    expect(sheetRule).not.toContain('!important');
  });
});
