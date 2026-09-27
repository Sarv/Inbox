import type { ReactNode } from 'react';

import { useAppearance } from '../../appearance';
import { Tooltip } from '../Tooltip';

import { showsToolbarIcon, showsToolbarLabel, toolbarButtonClass, toolbarModeFor } from './toolbar-button-view';

interface ToolbarButtonProps {
  /** The action's name. It is the tooltip, the accessible name, and the visible
   *  label when the reader asked for labels — one string, so the three can
   *  never disagree. */
  name: string;
  /** Tooltip text when the hover hint should say more than the visible label
   *  ("Back" on the button, "Back to list" on hover). Defaults to `name`. */
  tooltip?: string;
  icon: ReactNode;
  onClick: () => void;
  shortcut?: string | string[];
  disabled?: boolean;
  /** Colour-only extras (text-destructive, disabled:opacity-30…). */
  className?: string;
  /** Keeps the visible name in icon mode — for the toolbar's primary action. */
  alwaysLabel?: boolean;
  /** A popover anchored to this button; rendered inside its relative wrapper. */
  dropdown?: ReactNode;
  /** Suppress the tooltip (e.g. while this button's dropdown is open). */
  tooltipHidden?: boolean;
}

/**
 * One action in the message toolbar. Wraps the tooltip, the accessible name and
 * the Appearance ▸ Layout "button labels" mode in a single component, so every
 * action honours the setting and no action can ship without a tooltip.
 */
export function ToolbarButton({
  name,
  tooltip,
  icon,
  onClick,
  shortcut,
  disabled,
  className,
  alwaysLabel,
  dropdown,
  tooltipHidden,
}: ToolbarButtonProps) {
  const { buttonLabels } = useAppearance();
  const mode = toolbarModeFor(buttonLabels, alwaysLabel);

  const button = (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={name}
      className={toolbarButtonClass(mode, className)}
    >
      {showsToolbarIcon(mode) && icon}
      {showsToolbarLabel(mode) && <span>{name}</span>}
    </button>
  );

  return (
    // 40ms rather than the 150ms default: a toolbar of icon-only buttons is
    // unreadable until its tooltips feel instant.
    <Tooltip content={tooltip ?? name} shortcut={shortcut} hidden={tooltipHidden} delayMs={40}>
      {dropdown ? (
        <div className="relative">
          {button}
          {dropdown}
        </div>
      ) : (
        button
      )}
    </Tooltip>
  );
}
