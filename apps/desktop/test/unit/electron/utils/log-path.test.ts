import { homedir } from 'os';
import { join } from 'path';

import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ userData: '' as string, throws: false }));

vi.mock('electron', () => ({
  app: {
    getPath: () => {
      if (h.throws) throw new Error('app not ready');
      return h.userData;
    },
  },
}));

import { logPath, withoutHomeDir } from '../../../../electron/utils/log-path';

const HOME = homedir();

describe('logPath', () => {
  // Breaks if a main-process line ("[CoreDB] opened …", "Created runtime ->
  // …") writes an absolute path, which names the user through their home.
  it('writes a data-folder path relative to <userData> and others relative to ~', () => {
    h.userData = join(HOME, 'Library', 'Application Support', 'Sarv Inbox');
    h.throws = false;
    expect(logPath(join(h.userData, 'sarvinbox-core.db'))).toBe('<userData>/sarvinbox-core.db');
    expect(logPath(join(HOME, 'Documents', 'extensions.json'))).toBe('~/Documents/extensions.json');
  });

  // Breaks if a line logged before the app is ready (no userData yet) throws
  // inside a catch instead of writing a safe path.
  it('falls back to home when userData cannot be read', () => {
    h.throws = true;
    expect(logPath(join(HOME, 'x', 'y.db'))).toBe('~/x/y.db');
    h.throws = false;
  });
});

describe('withoutHomeDir', () => {
  // Breaks if a library's message passes its absolute path straight through.
  it('writes the home folder as ~', () => {
    const out = withoutHomeDir(`open '${join(HOME, 'a.txt')}' failed`);
    expect(out).not.toContain(HOME);
    expect(out).toMatch(/^open '~[\\/]a\.txt' failed$/);
  });
});
