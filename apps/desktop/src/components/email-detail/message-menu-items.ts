import { AtSign, Copy, ExternalLink, Link } from 'lucide-react';

import { isMailtoLink, opensExternally } from '../../utils/open-external';

import type { MenuItem } from './EmailMenu';

/**
 * The address a `mailto:` link writes to, decoded — what "Copy email address"
 * copies. The link itself when there is no address to take out of it (only a
 * `?to=` query, or an encoding that does not decode), so the item never copies
 * an empty string.
 */
export function mailtoAddress(href: string): string {
  try {
    return decodeURIComponent(new URL(href).pathname) || href;
  } catch {
    return href;
  }
}

/** What the reader right-clicked on, beyond the message itself. */
export interface MessageMenuTarget {
  /** The link under the pointer, or null. */
  href: string | null;
  /** The selected text inside this message, or ''. */
  selectionText: string;
}

export interface MessageMenuActions {
  copy: (text: string) => void;
  openLink: (url: string) => void;
}

/**
 * The items a right-click menu puts above the message's own: Copy for a
 * selection, and the link's items for a link.
 *
 * They exist because the app has no native context menu at all — a custom
 * right-click menu without them would leave the reader no way to copy what
 * they selected or the link they pointed at. Each appears only when it has
 * something to act on: a Copy with nothing selected, or an Open link for a
 * link the app refuses to open, is a menu item that does nothing.
 */
export function messageMenuLeadingItems(
  { href, selectionText }: MessageMenuTarget,
  { copy, openLink }: MessageMenuActions,
): MenuItem[] {
  const items: MenuItem[] = [];
  if (selectionText) {
    items.push({ id: 'copy', label: 'Copy', icon: Copy, onSelect: () => copy(selectionText) });
  }
  if (!href) return items;
  if (isMailtoLink(href)) {
    items.push({
      id: 'copy-address',
      label: 'Copy email address',
      icon: AtSign,
      onSelect: () => copy(mailtoAddress(href)),
    });
    return items;
  }
  if (opensExternally(href)) {
    items.push({ id: 'open-link', label: 'Open link', icon: ExternalLink, onSelect: () => openLink(href) });
  }
  items.push({ id: 'copy-link', label: 'Copy link', icon: Link, onSelect: () => copy(href) });
  return items;
}
