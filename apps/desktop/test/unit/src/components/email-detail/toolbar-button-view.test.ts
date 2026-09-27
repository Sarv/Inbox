import { describe, expect, it } from 'vitest';

import { BUTTON_LABEL_CHOICES } from '../../../../../src/appearance';
import {
  showsToolbarIcon,
  showsToolbarLabel,
  toolbarButtonClass,
  toolbarModeFor,
} from '../../../../../src/components/email-detail/toolbar-button-view';

// ---------------------------------------------------------------------------
// How a message-toolbar action is drawn, by the reader's button-label mode
// (Appearance -> Layout).
//
// What breaks if this goes red: a mode that draws neither a glyph nor a name —
// fifteen blank buttons — or "Icons only" quietly dropping Reply's label and
// changing the default install's toolbar.
// ---------------------------------------------------------------------------
const MODES = BUTTON_LABEL_CHOICES.map((choice) => choice.id);

describe('toolbarButtonClass', () => {
  it('draws a square icon button in icon mode', () => {
    expect(toolbarButtonClass('icons')).toContain('p-2');
    expect(toolbarButtonClass('icons')).not.toContain('flex');
  });

  it('draws a wider labelled button once a name is shown', () => {
    for (const mode of ['text', 'both'] as const) {
      expect(toolbarButtonClass(mode)).toContain('px-3');
      expect(toolbarButtonClass(mode)).toContain('items-center');
    }
  });

  // Regression: hover feedback and the radius are what make the row read as a
  // toolbar. A mode that loses them looks like plain text.
  it('keeps the shared hover, radius and transition in every mode', () => {
    for (const mode of MODES) {
      expect(toolbarButtonClass(mode)).toContain('hover:bg-accent');
      expect(toolbarButtonClass(mode)).toContain('rounded-md');
    }
  });

  // The caller's colour-only classes (text-destructive, disabled:opacity-30)
  // are orthogonal to the mode and must survive it.
  it('appends the caller classes', () => {
    expect(toolbarButtonClass('icons', 'text-destructive')).toContain('text-destructive');
  });

  it('leaves no stray separator when the caller adds nothing', () => {
    expect(toolbarButtonClass('icons')).toBe(toolbarButtonClass('icons', '').trim());
    expect(toolbarButtonClass('icons')).not.toMatch(/\s{2}|\s$/);
  });
});

describe('what each mode shows', () => {
  // THE REGRESSION: a blank button. Every mode must draw at least one of the
  // two, or an action becomes unidentifiable and unfindable.
  it('always draws a glyph, a name, or both', () => {
    for (const mode of MODES) {
      expect(showsToolbarIcon(mode) || showsToolbarLabel(mode)).toBe(true);
    }
  });

  it('shows the glyph alone for icons, the name alone for text, and both for both', () => {
    expect([showsToolbarIcon('icons'), showsToolbarLabel('icons')]).toEqual([true, false]);
    expect([showsToolbarIcon('text'), showsToolbarLabel('text')]).toEqual([false, true]);
    expect([showsToolbarIcon('both'), showsToolbarLabel('both')]).toEqual([true, true]);
  });
});

describe('toolbarModeFor', () => {
  // Regression: 'icons' is the DEFAULT, and Reply has always shown its name.
  // Without this exception, shipping the setting silently restyles every
  // existing install's toolbar.
  it('keeps a primary action labelled even in icon mode', () => {
    expect(toolbarModeFor('icons', true)).toBe('both');
    expect(showsToolbarLabel(toolbarModeFor('icons', true))).toBe(true);
  });

  it('leaves an ordinary action in the reader-chosen mode', () => {
    for (const mode of MODES) expect(toolbarModeFor(mode)).toBe(mode);
  });

  // The exception only ADDS a label; it must never re-add a glyph the reader
  // asked to drop.
  it('never overrides a mode the reader chose explicitly', () => {
    expect(toolbarModeFor('text', true)).toBe('text');
    expect(toolbarModeFor('both', true)).toBe('both');
  });
});
