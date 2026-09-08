/*
 * Guards scripts/lib/dev-processes.mjs — the patterns `sh scripts/dev.sh` hands
 * to `pkill -f` to clear the previous run before starting a new one.
 *
 * This file exists because the original patterns were wrong for the entire life
 * of the script and nothing noticed. They were written inline in bash as
 * "electron.*sarvinbox" and "vite.*desktop"; the first needs "electron" to
 * appear BEFORE "sarvinbox" but the real argv has them the other way round, and
 * the second looks for "desktop" in a command line that only ever contains
 * `node <root>/node_modules/.bin/vite`. So the kill step was a silent no-op:
 * every restart left the old Electron holding port 5173 and the old vite
 * serving stale bundles, with two processes on one SQLite mail database.
 *
 * The lesson encoded here: a process-matching pattern is code, and it gets a
 * test. Each case below asserts against a command line copied from real `ps`
 * output rather than one invented to fit the pattern.
 */

import { describe, it, expect } from 'vitest';

import { escapeEre, stalePatterns } from '../../../../../scripts/lib/dev-processes.mjs';

/** What `pkill -f <pattern>` does: POSIX ERE, unanchored, against full argv. */
const pkillMatches = (patterns: string[], commandLine: string) =>
  patterns.some((p) => new RegExp(p).test(commandLine));

const ROOT = '/Users/dev/Inbox';
const patterns = stalePatterns(ROOT);

// Real argv shapes, taken from `ps aux` while the dev app was running.
const ELECTRON_MAIN = `${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Sarv Inbox Dev`;
const ELECTRON_HELPER = `${ROOT}/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU) --type=gpu-process`;
const VITE = `node ${ROOT}/node_modules/.bin/vite`;
const ESBUILD = `${ROOT}/node_modules/vite/node_modules/@esbuild/darwin-arm64/bin/esbuild --service=0.21.5`;

describe('stalePatterns — what dev.sh kills before restarting', () => {
  // If this fails the restart leaves the old app running: port 5173 is taken,
  // and two Electron instances write the same SQLite file.
  it('matches the Electron main process of this checkout', () => {
    expect(pkillMatches(patterns, ELECTRON_MAIN)).toBe(true);
  });

  // Helpers outlive a killed parent and keep the DB and port held.
  it('matches Electron helper processes too', () => {
    expect(pkillMatches(patterns, ELECTRON_HELPER)).toBe(true);
  });

  // The vite argv contains no "desktop" — the reason the old pattern missed it.
  it('matches the vite dev server, whose argv never mentions "desktop"', () => {
    expect(pkillMatches(patterns, VITE)).toBe(true);
  });

  it('matches the esbuild service vite spawns from the same tree', () => {
    expect(pkillMatches(patterns, ESBUILD)).toBe(true);
  });

  // The exact regression: both historical patterns matched nothing at all.
  it('the historical patterns matched none of these — do not reintroduce them', () => {
    const historical = ['electron.*sarvinbox', 'vite.*desktop'];
    for (const cmd of [ELECTRON_MAIN, ELECTRON_HELPER, VITE, ESBUILD]) {
      expect(pkillMatches(historical, cmd)).toBe(false);
    }
  });

  // Killing by checkout path must not reach past this checkout. A second clone,
  // or somebody else's Electron app, has to survive.
  it('leaves a different checkout of the same repo alone', () => {
    const other = '/Users/dev/Inbox-worktree/node_modules/electron/dist/Electron.app/Contents/MacOS/Sarv Inbox Dev';
    expect(pkillMatches(patterns, other)).toBe(false);
  });

  it('leaves unrelated Electron apps alone', () => {
    const slack = '/Applications/Slack.app/Contents/MacOS/Slack';
    const otherProject = '/Users/dev/some-other-app/node_modules/electron/dist/electron';
    expect(pkillMatches(patterns, slack)).toBe(false);
    expect(pkillMatches(patterns, otherProject)).toBe(false);
  });

  // dev.sh passes "$PWD"; a trailing slash must not produce "//" and stop matching.
  it('tolerates a trailing slash on the repo root', () => {
    expect(pkillMatches(stalePatterns(`${ROOT}/`), ELECTRON_MAIN)).toBe(true);
  });

  it('emits one pattern per process family', () => {
    expect(patterns).toHaveLength(2);
    expect(patterns.every((p) => p.length > 0)).toBe(true);
  });
});

describe('escapeEre — checkout paths are not regexes', () => {
  // An unescaped "." matches any character, so a path like /dev/my.app would
  // also match /dev/myXapp — killing a neighbouring project's processes.
  it('escapes the dot so a path cannot match a look-alike sibling', () => {
    const dotted = stalePatterns('/Users/dev/my.app');
    expect(pkillMatches(dotted, '/Users/dev/my.app/node_modules/electron/dist/electron')).toBe(true);
    expect(pkillMatches(dotted, '/Users/dev/myXapp/node_modules/electron/dist/electron')).toBe(false);
  });

  it('escapes the other ERE metacharacters a real path can contain', () => {
    for (const ch of ['.', '[', ']', '(', ')', '{', '}', '*', '+', '?', '^', '$', '|', '-']) {
      const escaped = escapeEre(`a${ch}b`);
      expect(new RegExp(escaped).test(`a${ch}b`)).toBe(true);
      // A literal match only — the metacharacter must have lost its power.
      expect(() => new RegExp(escaped)).not.toThrow();
    }
  });

  it('survives a path with spaces and parentheses', () => {
    const messy = '/Users/dev/Projects (old)/Sarv Inbox';
    const p = stalePatterns(messy);
    expect(pkillMatches(p, `${messy}/node_modules/.bin/vite`)).toBe(true);
  });
});
