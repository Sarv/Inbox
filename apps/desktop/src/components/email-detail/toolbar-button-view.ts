// How a toolbar action is drawn, by the reader's button-label mode — pure, so
// the rule is tested without rendering a toolbar. Shared by ToolbarButton and
// by the menu triggers (LabelMenu, FolderPicker) that render their own button
// but must sit in the same row without looking like a different control.
import type { ButtonLabelMode } from '../../appearance';

/** Hover, radius and transition — identical in every mode; only the box changes. */
const TOOLBAR_BUTTON_BASE = 'hover:bg-accent rounded-md transition-colors';

/**
 * The trigger's classes: a square icon button, or a wider labelled one.
 * `extra` carries colour-only additions (text-destructive, disabled:opacity-30…)
 * that are orthogonal to the mode.
 */
export const toolbarButtonClass = (mode: ButtonLabelMode, extra = ''): string =>
  [
    mode === 'icons'
      ? `p-2 ${TOOLBAR_BUTTON_BASE}`
      : `flex items-center gap-2 px-3 py-2 text-sm font-medium ${TOOLBAR_BUTTON_BASE}`,
    extra,
  ]
    .filter(Boolean)
    .join(' ');

/** Whether the glyph is drawn. 'text' asks for the name alone. */
export const showsToolbarIcon = (mode: ButtonLabelMode): boolean => mode !== 'text';

/** Whether the action's name is drawn beside (or instead of) the glyph. */
export const showsToolbarLabel = (mode: ButtonLabelMode): boolean => mode !== 'icons';

/**
 * The mode a single action is drawn in. An action marked `alwaysLabel` (Reply,
 * the toolbar's one primary action) keeps its visible name even in icon mode —
 * that is how the toolbar has always looked, and 'icons' is the default, so
 * turning the setting on must not silently strip it.
 */
export const toolbarModeFor = (mode: ButtonLabelMode, alwaysLabel = false): ButtonLabelMode =>
  alwaysLabel && mode === 'icons' ? 'both' : mode;
