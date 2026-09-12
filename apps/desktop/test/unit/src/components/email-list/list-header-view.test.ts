import { describe, it, expect } from 'vitest';

import { listHeaderTitle } from '../../../../../src/components/email-list/list-header-view';

/**
 * The title on the one top bar every listing wears. What breaks if these fail:
 * a bar with prev/next and no idea what it is paging — which is how Sent ended
 * up with no header at all (only the section / All Inboxes / AI-category views
 * hand-rolled one, so a plain folder fell through to nothing).
 */
describe('listHeaderTitle', () => {
  it('names a plain folder by its role label, not the server path', () => {
    expect(listHeaderTitle({ folder: { path: 'Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' } })).toBe('Sent');
    expect(listHeaderTitle({ folder: { path: 'INBOX', name: 'INBOX' } })).toBe('Inbox');
  });

  it('keeps a user folder\'s own name, minus the Gmail prefix', () => {
    expect(listHeaderTitle({ folder: { path: 'Projects/2026', name: 'Projects/2026' } })).toBe('Projects/2026');
    expect(listHeaderTitle({ folder: { path: '[Gmail]/Chats', name: '[Gmail]/Chats' } })).toBe('Chats');
    // ...but a role wins over the raw name: Gmail's All Mail IS the archive.
    expect(listHeaderTitle({ folder: { path: '[Gmail]/All Mail', name: '[Gmail]/All Mail' } })).toBe('Archive');
  });

  it('names the virtual views from the one list the sidebar uses', () => {
    expect(listHeaderTitle({ virtualFolder: 'virtual-all' })).toBe('All Email');
    expect(listHeaderTitle({ virtualFolder: 'virtual-starred' })).toBe('Starred');
    expect(listHeaderTitle({ virtualFolder: 'virtual-important' })).toBe('Important');
    expect(listHeaderTitle({ virtualFolder: 'virtual-unified' })).toBe('All Inboxes');
  });

  it('title-cases an AI category slug', () => {
    expect(listHeaderTitle({ aiCategory: 'needs-response' })).toBe('Needs Response');
    expect(listHeaderTitle({ aiCategory: 'to_reply' })).toBe('To Reply');
  });

  it('lets the drilled-into view win over the folder it sits on', () => {
    // Order matters: the section full page, search and a category are all opened
    // ON TOP of a folder that is still selected as the return target. Titling
    // them "Inbox" would say the reader is somewhere they are not.
    const folder = { path: 'INBOX', name: 'INBOX' };
    expect(listHeaderTitle({ sectionLabel: 'Unread', searching: true, folder })).toBe('Unread');
    expect(listHeaderTitle({ searching: true, aiCategory: 'needs-response', folder })).toBe('Search results');
    expect(listHeaderTitle({ aiCategory: 'needs-response', folder })).toBe('Needs Response');
    expect(listHeaderTitle({ snoozed: true, folder })).toBe('Snoozed');
  });

  it('returns null when there is no list to head, so no bare pager renders', () => {
    expect(listHeaderTitle({})).toBeNull();
    expect(listHeaderTitle({ folder: null, virtualFolder: null })).toBeNull();
    // An unknown virtual id is a bug elsewhere; head nothing rather than "".
    expect(listHeaderTitle({ virtualFolder: 'virtual-made-up' })).toBeNull();
  });
});
