import { join, sep } from 'path';

import { describe, expect, it } from 'vitest';

import { pathForLog, redactHomeDir } from '../../../src/utils/log-paths';

const HOME = join(sep, 'Users', 'ramesh');
const USER_DATA = join(HOME, 'Library', 'Application Support', 'Sarv Inbox');

describe('pathForLog', () => {
  // Regression: a log line names the user through their home folder (/Users/<name>).
  it('writes a data-folder path relative to <userData>', () => {
    expect(pathForLog(join(USER_DATA, 'sarvinbox.db'), { userData: USER_DATA, home: HOME })).toBe('<userData>/sarvinbox.db');
    expect(pathForLog(join(USER_DATA, 'cache', 'a.bin'), { userData: USER_DATA, home: HOME })).toBe('<userData>/cache/a.bin');
    expect(pathForLog(USER_DATA, { userData: USER_DATA, home: HOME })).toBe('<userData>');
  });

  // Regression: a path elsewhere under home still names the user.
  it('writes another path under home relative to ~', () => {
    expect(pathForLog(join(HOME, 'Downloads', 'x.pdf'), { userData: USER_DATA, home: HOME })).toBe('~/Downloads/x.pdf');
    expect(pathForLog(HOME, { home: HOME })).toBe('~');
  });

  // Regression: a sibling folder that merely shares the prefix (/Users/rameshx) is treated as home.
  it('writes the file name alone for anything outside both, and for relative paths', () => {
    expect(pathForLog(join(sep, 'Users', 'rameshx', 'a.db'), { userData: USER_DATA, home: HOME })).toBe('a.db');
    expect(pathForLog(join(sep, 'tmp', 'x', 'y.log'), { home: HOME })).toBe('y.log');
    expect(pathForLog(join('rel', 'z.txt'), { home: HOME })).toBe('z.txt');
    expect(pathForLog(undefined, { home: HOME })).toBe('none');
  });
});

describe('redactHomeDir', () => {
  // Regression: the release backstop lets a library's absolute path (updater cache, stack) through.
  it('replaces the home folder with ~ wherever it appears', () => {
    const line = `downloaded to /Users/ramesh/Library/Caches/u.zip; at file:///Users/ramesh/app/x.js:1`;
    expect(redactHomeDir(line, '/Users/ramesh')).toBe('downloaded to ~/Library/Caches/u.zip; at file://~/app/x.js:1');
    expect(redactHomeDir('home is /Users/ramesh', '/Users/ramesh/')).toBe('home is ~');
  });

  // Regression: a short home rewrites someone else's longer folder name.
  it('leaves a longer folder name that starts with home alone', () => {
    expect(redactHomeDir('/Users/rameshsarv/x and /Users/ramesh.old', '/Users/ramesh')).toBe('/Users/rameshsarv/x and /Users/ramesh.old');
  });

  // Regression: Windows paths escape the backstop when printed by util.inspect (doubled \\) or with /.
  it('matches a Windows home with single, doubled and forward slashes', () => {
    const home = 'C:\\Users\\Ramesh';
    expect(redactHomeDir('at C:\\Users\\Ramesh\\AppData\\x', home)).toBe('at ~\\AppData\\x');
    expect(redactHomeDir("{ path: 'C:\\\\Users\\\\Ramesh\\\\AppData' }", home)).toBe("{ path: '~\\\\AppData' }");
    expect(redactHomeDir('url C:/Users/Ramesh/AppData', home)).toBe('url ~/AppData');
  });

  // Regression: a misconfigured HOME of "/" replaces every slash in every line.
  it('does nothing without a usable home', () => {
    expect(redactHomeDir('/a/b', '/')).toBe('/a/b');
    expect(redactHomeDir('/a/b', undefined)).toBe('/a/b');
    expect(redactHomeDir('/a/b', '')).toBe('/a/b');
  });
});
