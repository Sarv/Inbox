import { describe, expect, it } from 'vitest';

import { buildIframeCss } from '../../../../src/components/SandboxedEmailBody';
import { DARK_PAPER, darkenColorToken } from '../../../../src/utils/email-dark-mode';

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
// A fifth flag, darkCanvas, splits the FIRST of those in two: the Standard pane
// on white (everyone, today) and the Standard pane on a dark canvas (the reader
// who turned "Dark email bodies" on). It changes the colours, never which pane
// this is — so the pane's own fixes have to survive it.
//
// Which rules reach which page is the part that has actually been got wrong,
// and it cannot be reached through the component — jsdom neither lays out nor
// renders `srcdoc`.

const standard = (isDark = false) => buildIframeCss(isDark, false, false, false);
// The Standard pane again, but with the reader's opt-in dark bodies on: the
// same page, no longer on a white canvas.
const darkStandard = () => buildIframeCss(true, false, false, false, true);
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

describe('the dark-bodies canvas', () => {
  // Regression: the default. Calling with four arguments — which every caller
  // outside the dark-bodies path still does — must produce exactly the
  // stylesheet it produced before the flag existed.
  it('defaults to off, leaving the four-argument call unchanged', () => {
    expect(buildIframeCss(true, false, false, false, false)).toBe(standard(true));
    expect(buildIframeCss(true, true, true, true, false)).toBe(buildIframeCss(true, true, true, true));
  });

  // Regression: THE point of the flag. Force white here and the re-coloured
  // message is painted onto a white page — dark text on dark, unreadable.
  it('stops forcing the white page', () => {
    expect(standard()).toContain('background-color: #ffffff;');
    expect(darkStandard()).not.toContain('background-color: #ffffff;');
  });

  // Regression: the frame's own foreground is what an email that declares NO
  // colour of its own gets. Leave it at the light value and a plain-text mail
  // renders near-black on the new dark canvas.
  it('uses the dark foreground and link colours', () => {
    expect(darkStandard()).toContain('color: hsl(210, 40%, 98%);');
    expect(darkStandard()).toContain('a { color: hsl(217.2, 91.2%, 59.8%); }');
    expect(standard(true)).toContain('color: hsl(222.2, 84%, 4.9%);');
  });

  // Regression: this is still the Standard reading pane, so its own fixes —
  // the attachment-chip un-clip, which exists because our system font is wider
  // than the sender's — must not fall off the moment the canvas goes dark.
  it('keeps the Standard pane fixes that have nothing to do with the canvas', () => {
    expect(darkStandard()).toContain('attachment-chip');
    expect(tintedBubble()).not.toContain('attachment-chip');
  });

  // Regression: the paper/table-sheet rules are for a canvas carrying the
  // sender's TINT, where a stray white slab reads as a second background.
  // A dark canvas is still a canvas of our own, and blanking the sender's
  // backgrounds there would strip the message we just re-coloured.
  it('does not turn on the transparent-canvas surface rules', () => {
    expect(darkStandard()).not.toContain('sec-paper');
    expect(darkStandard()).not.toContain('sec-table-sheet');
  });

  // Regression: THE bug this rule exists for, and the one that made the whole
  // feature look dead. `color-scheme: dark` on the <iframe> only decides what
  // `prefers-color-scheme` resolves to for the document it embeds; that
  // document's OWN scheme stays `normal`, and the UA paints the frame's canvas
  // from the document's. Drop this line and a message whose colours have just
  // been moved for a dark page is drawn on an opaque WHITE one — the exact
  // "dark email bodies does nothing" report. Not reachable through the
  // component: jsdom/happy-dom never paint a canvas.
  it('declares the dark colour scheme inside the document, not just on the frame', () => {
    expect(darkStandard()).toContain('color-scheme: dark;');
  });

  // Regression: the mirror of the forced white canvas. Left transparent, the
  // dark canvas lets the app's chrome show through the message — and the
  // engine's own paper, which is what it turns a sender's `background: white`
  // into, then lands as a visibly LIGHTER slab on top of that chrome. The two
  // have to agree, so the canvas takes the colour from the engine instead of
  // repeating it.
  it('paints the paper the engine inverts a white page to', () => {
    expect(darkStandard()).toContain(`background-color: ${DARK_PAPER};`);
    expect(DARK_PAPER).toBe(darkenColorToken('#ffffff', 'surface', 'inverted'));
    expect(DARK_PAPER).not.toContain('255');
  });

  // Regression: the scheme must ride on the dark canvas alone. Emitted on the
  // white Standard page it would flip that page's UA colours — form controls,
  // scrollbars and the canvas itself — under every reader who never opted in.
  it('says nothing about the colour scheme on any other canvas', () => {
    expect(standard()).not.toContain('color-scheme');
    expect(standard(true)).not.toContain('color-scheme');
    expect(tintedBubble()).not.toContain('color-scheme');
    expect(normalizedBubble(true)).not.toContain('color-scheme');
  });
});
