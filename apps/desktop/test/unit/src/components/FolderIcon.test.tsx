// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { FolderIcon } from '../../../../src/components/FolderIcon';
import { cleanup, render } from '../../../helpers/render';

afterEach(cleanup);

/** The lucide icon a folder row gets, by its `lucide-<name>` class. */
const iconOf = (folder: { path: string; specialUse?: string }) => {
  const svg = render(<FolderIcon folder={folder} />).container.querySelector('svg');
  return [...(svg?.classList ?? [])].find((c) => c.startsWith('lucide-'));
};

describe('FolderIcon — the star goes by the folder\'s role', () => {
  // Breaks if a real Starred mailbox loses its star in the sidebar, including a
  // localised Gmail one that only its \Flagged SPECIAL-USE flag identifies.
  it.each([
    { path: '[Gmail]/Starred' },
    { path: 'Starred' },
    { path: 'Flagged' },
    { path: '[Gmail]/Markiert', specialUse: '\\Flagged' },
  ])('stars $path', (folder) => {
    expect(iconOf(folder)).toBe('lucide-star');
  });

  // Breaks if the old `path.includes('star')` test comes back: the user's own
  // folders wear the Starred mailbox's star while opening with their own mail.
  it.each(['Startups', 'Clients/Restart', 'Recipes/Mustard', 'Starred clients'])('gives %s the plain folder icon', (path) => {
    expect(iconOf({ path })).toBe('lucide-folder');
  });

  // Breaks if moving the icon picker out of Sidebar changed any other role's icon.
  it.each([
    ['INBOX', 'lucide-inbox'],
    ['[Gmail]/Important', 'lucide-chevron-right'],
    ['[Gmail]/All Mail', 'lucide-mail'],
    ['[Gmail]/Sent Mail', 'lucide-send'],
    ['Drafts', 'lucide-file-text'],
    ['Archive', 'lucide-archive'],
    ['Deleted Items', 'lucide-trash2'],
    ['Junk', 'lucide-ban'],
  ])('keeps %s on %s', (path, icon) => {
    expect(iconOf({ path })).toBe(icon);
  });
});
