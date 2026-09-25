import { useSyncExternalStore } from 'react';

import type { Appearance, ResolvedTheme } from './appearance';
import { getAppearance, getResolvedTheme, subscribeAppearance } from './appearance-store';

/**
 * The live appearance, re-rendering the caller whenever it changes — including
 * changes made from outside React (the View menu's Cmd +/-, or the OS flipping
 * to dark while the mode is 'system').
 *
 * `useSyncExternalStore` rather than a `useState` + effect because the store is
 * read during render by components that must not flash the previous theme.
 */
export const useAppearance = (): Appearance =>
  useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);

/** The theme in effect, with 'system' already resolved against the OS. */
export const useResolvedTheme = (): ResolvedTheme =>
  useSyncExternalStore(subscribeAppearance, getResolvedTheme, getResolvedTheme);
