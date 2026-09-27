/**
 * The page a framed chat body is drawn on, decided per message.
 *
 * Up to @sarv-in/email-chat-view 0.2.4 the frame document declared no
 * `color-scheme`, so it was always a LIGHT document; from 0.2.5 it copies the
 * host's scheme in, which is why `chat-view-theme.css` sets it on the host. In the dark app theme the `<iframe>` element inherits
 * `color-scheme: dark` from the root (`applyAppearance`), and Chromium answers
 * that mismatch by painting the frame an opaque white backdrop — wherever the
 * mail itself paints nothing. Two visible failures came from that one fact:
 *
 *   • Dark bodies ON: the re-coloured prose sat on dark paper, but the area
 *     beside a table (which paints nothing) came through as a white slab.
 *   • Dark bodies OFF: the mail was on that white backdrop, yet the library
 *     tinted the table rows and header cells with the app's DARK tokens — dark
 *     rows holding the sender's black text inside a white page.
 *
 * So the app stops leaving the canvas to accident: every framed body in the
 * dark theme is tagged with the page it was prepared for, and
 * `chat-view-theme.css` paints that page and hands the frame matching tokens.
 * In the light theme nothing is tagged — the frame is light, the app is light,
 * and they already agree.
 */
import type { EmailDarkResult } from '../../utils/email-dark-mode';

/** `paper` — the white page the mail was written for. `dark-paper` — the page a re-coloured mail was written onto. */
export type FrameCanvas = 'paper' | 'dark-paper';

/** The `applied` entries the canvas reaches the DOM as (`data-sec-applied`). */
export const PAPER_CANVAS_MARKER = 'canvas-paper';
export const DARK_CANVAS_MARKER = 'canvas-dark';

const MARKERS: Readonly<Record<FrameCanvas, string>> = {
  paper: PAPER_CANVAS_MARKER,
  'dark-paper': DARK_CANVAS_MARKER,
};

/** A body after the dark-mode pass, and the page it now needs. */
export interface RecoloredBody {
  html: string;
  canvas?: FrameCanvas;
}

/**
 * Which page a body needs, from what the dark-mode pass did to it.
 *
 * Follows the pass's own verdict rather than the setting: with dark bodies on,
 * a message too large to walk comes back untouched (`off`) and still needs the
 * white page it was written for.
 */
export const frameCanvasFor = (
  result: Pick<EmailDarkResult, 'darkCanvas'>,
  isDark: boolean,
): FrameCanvas | undefined => {
  if (!isDark) return undefined;
  return result.darkCanvas ? 'dark-paper' : 'paper';
};

/**
 * `applied` with the canvas marker added. Appended, never replacing: `as-sent`
 * lives in the same list and its rule must keep matching. Hands back the same
 * array when there is nothing to add, so an untouched message stays the same
 * object and nothing downstream re-renders.
 */
export const withCanvasMarker = (
  applied: string[] | undefined,
  canvas: FrameCanvas | undefined,
): string[] | undefined => {
  if (!canvas) return applied;
  const marker = MARKERS[canvas];
  if (applied?.includes(marker)) return applied;
  return [...(applied ?? []), marker];
};
