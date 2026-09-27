import { describe, expect, it } from 'vitest';

import {
  DARK_CANVAS_MARKER,
  frameCanvasFor,
  PAPER_CANVAS_MARKER,
  withCanvasMarker,
} from '../../../../../src/components/email-detail/chat-frame-canvas';

describe('frameCanvasFor', () => {
  // Regression: the light theme must tag nothing. The frame is already light
  // there, and a marker would repaint every framed bubble for no reason.
  it('asks for no canvas in the light theme', () => {
    expect(frameCanvasFor({ darkCanvas: false }, false)).toBeUndefined();
    expect(frameCanvasFor({ darkCanvas: true }, false)).toBeUndefined();
  });

  // Regression: dark bodies OFF in the dark theme. Without the paper canvas
  // the frame gets the dark theme's tokens: dark table rows of the sender's
  // black text inside a white page.
  it('puts a mail left as written onto white paper in the dark theme', () => {
    expect(frameCanvasFor({ darkCanvas: false }, true)).toBe('paper');
  });

  // Regression: dark bodies ON. Without the dark canvas whatever the mail
  // leaves unpainted — the area beside a table — shows as a white slab.
  it('puts a re-coloured mail onto dark paper in the dark theme', () => {
    expect(frameCanvasFor({ darkCanvas: true }, true)).toBe('dark-paper');
  });
});

describe('withCanvasMarker', () => {
  // Regression: handing back a new array when nothing changed defeats the
  // adapter's same-object check and re-renders every bubble.
  it('returns the same list when no canvas is asked for', () => {
    const applied = ['as-sent'];
    expect(withCanvasMarker(applied, undefined)).toBe(applied);
    expect(withCanvasMarker(undefined, undefined)).toBeUndefined();
  });

  // Regression: replacing the list drops `as-sent`, and the per-sender pastel
  // comes back over a mail shown exactly as sent.
  it('appends the marker and keeps what was already there', () => {
    expect(withCanvasMarker(['as-sent'], 'paper')).toEqual(['as-sent', PAPER_CANVAS_MARKER]);
    expect(withCanvasMarker(undefined, 'dark-paper')).toEqual([DARK_CANVAS_MARKER]);
  });

  // Regression: a message that goes through the pass twice (a re-render with
  // the same inputs) must not collect a second copy of the marker.
  it('does not add a marker twice', () => {
    const applied = [DARK_CANVAS_MARKER];
    expect(withCanvasMarker(applied, 'dark-paper')).toBe(applied);
  });
});
