import { Sparkles } from 'lucide-react';
import type { RefObject } from 'react';

import { MENU_WIDTH, type MenuPlacement } from '../utils/menu-placement';

/** The menu's width, matching its `w-56` — what placement keeps on-screen. */
export const SELECTION_MENU_WIDTH = MENU_WIDTH;

interface SelectionPolishMenuProps {
  menuRef: RefObject<HTMLDivElement | null>;
  /** Where it goes: `placeMenu` at the pointer, so it stays inside the window. */
  placement: MenuPlacement;
  onPolish: () => void;
}

/**
 * The compose editors' right-click menu over a selection.
 *
 * One component for the reply, forward and compose editors, which each drew
 * their own copy — four of them, opened at the raw pointer with no clamping,
 * so a right-click near the window's right or bottom edge drew the menu partly
 * off-screen.
 */
export function SelectionPolishMenu({ menuRef, placement, onPolish }: SelectionPolishMenuProps) {
  return (
    <div
      ref={menuRef}
      className="fixed w-56 bg-card border border-border rounded-lg shadow-xl py-1 z-[200] overflow-y-auto"
      style={placement}
    >
      <button
        type="button"
        onClick={onPolish}
        className="flex items-center gap-2 w-full px-4 py-2 text-sm hover:bg-accent transition-colors"
      >
        <Sparkles className="h-4 w-4 text-primary" />
        Polish Selected Text
      </button>
    </div>
  );
}
