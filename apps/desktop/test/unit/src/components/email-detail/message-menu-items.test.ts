import { describe, expect, it, vi } from 'vitest';

import {
  mailtoAddress,
  messageMenuLeadingItems,
} from '../../../../../src/components/email-detail/message-menu-items';

/**
 * The items a right-click menu in the chat puts above the message's own.
 *
 * What breaks if this file goes red: the app has NO native context menu, so
 * these are the reader's only way to copy what they selected or the link they
 * pointed at. Missing, the selection cannot be copied with the mouse at all;
 * shown when there is nothing to act on, they are menu items that do nothing.
 */

const actions = () => ({ copy: vi.fn(), openLink: vi.fn() });
const labels = (items: { label: string }[]) => items.map((item) => item.label);

describe('messageMenuLeadingItems', () => {
  // A plain right-click — no selection, no link — adds nothing: the menu is
  // just the message's own.
  it('adds nothing for a right-click on plain text', () => {
    expect(messageMenuLeadingItems({ href: null, selectionText: '' }, actions())).toEqual([]);
  });

  // With a selection: Copy, which copies exactly the selection.
  it('offers Copy for the selection', () => {
    const a = actions();
    const items = messageMenuLeadingItems({ href: null, selectionText: 'the signed copy' }, a);
    expect(labels(items)).toEqual(['Copy']);
    items[0]!.onSelect();
    expect(a.copy.mock.calls).toEqual([['the signed copy']]);
  });

  // Over a web link: open it (through the app's own external-open path) or
  // copy it.
  it('offers Open link and Copy link over a web link', () => {
    const a = actions();
    const items = messageMenuLeadingItems({ href: 'https://example.test/doc', selectionText: '' }, a);
    expect(labels(items)).toEqual(['Open link', 'Copy link']);
    items[0]!.onSelect();
    items[1]!.onSelect();
    expect(a.openLink.mock.calls).toEqual([['https://example.test/doc']]);
    expect(a.copy.mock.calls).toEqual([['https://example.test/doc']]);
  });

  // Selection and link together: Copy first, then the link's items.
  it('offers the selection\'s item before the link\'s', () => {
    const items = messageMenuLeadingItems(
      { href: 'https://example.test/doc', selectionText: 'doc' },
      actions(),
    );
    expect(labels(items)).toEqual(['Copy', 'Open link', 'Copy link']);
  });

  // Regression guard: the app refuses to open mailto: links in the browser
  // (they are the compose window's job) — an "Open link" there would be an
  // item that does nothing. The address is what the reader wants.
  it('offers only the address for a mailto: link', () => {
    const a = actions();
    const items = messageMenuLeadingItems({ href: 'mailto:bob%40acme.example?subject=Hi', selectionText: '' }, a);
    expect(labels(items)).toEqual(['Copy email address']);
    items[0]!.onSelect();
    expect(a.copy.mock.calls).toEqual([['bob@acme.example']]);
    expect(a.openLink).not.toHaveBeenCalled();
  });

  // The scheme in any case: a sender's MAILTO: is still a mailto: link.
  it('treats an upper-case MAILTO: link as a mail address', () => {
    expect(labels(messageMenuLeadingItems({ href: 'MAILTO:bob@acme.example', selectionText: '' }, actions())))
      .toEqual(['Copy email address']);
  });

  // A link the app would not open (an in-document jump) is still copyable, but
  // not openable.
  it('offers no Open link for a link the app does not open', () => {
    expect(labels(messageMenuLeadingItems({ href: '#section-2', selectionText: '' }, actions())))
      .toEqual(['Copy link']);
  });
});

describe('mailtoAddress', () => {
  it('takes the decoded address out of the link, without its query', () => {
    expect(mailtoAddress('mailto:bob%40acme.example?subject=Hi')).toBe('bob@acme.example');
  });

  // Never an empty copy: a link with only a query copies the link itself.
  it('falls back to the link when it names no address', () => {
    expect(mailtoAddress('mailto:?to=bob@acme.example')).toBe('mailto:?to=bob@acme.example');
  });

  // Failure path: an encoding that does not decode must not throw out of a
  // menu click — the link itself is copied instead.
  it('falls back to the link when the address does not decode', () => {
    expect(mailtoAddress('mailto:bob%E0%A4%A')).toBe('mailto:bob%E0%A4%A');
  });
});
