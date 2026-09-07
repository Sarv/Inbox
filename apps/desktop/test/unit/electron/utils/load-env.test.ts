import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultDotEnvPaths, loadDotEnv } from '../../../../electron/utils/load-env';

/**
 * The documented contract of the dependency-free .env loader:
 *   - shell-provided vars ALWAYS win (an existing process.env key is never
 *     overwritten) — the precedence the app's dev/prod config relies on,
 *   - `#` comments and blank lines are ignored,
 *   - surrounding single/double quotes are stripped,
 *   - a missing file is a silent no-op,
 *   - the FIRST candidate path that exists wins (later ones are not read).
 */

// Every key the tests write, so process.env is left exactly as we found it.
const TOUCHED_KEYS = [
  'LE_PLAIN', 'LE_SPACED', 'LE_DQ', 'LE_SQ', 'LE_EMPTY', 'LE_INNER_EQ', 'LE_HASH_INLINE',
  'LE_FROM_FIRST', 'LE_FROM_SECOND', 'LE_SHELL_WINS', 'LE_MIXED_QUOTE', 'LE_CRLF',
  'LE_NO_EQ', 'LE_LOWER',
];

let dir: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sarvinbox-loadenv-'));
  for (const k of TOUCHED_KEYS) saved.set(k, process.env[k]);
  for (const k of TOUCHED_KEYS) delete process.env[k];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

const writeEnv = (name: string, content: string): string => {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
};

describe('loadDotEnv', () => {
  it('parses KEY=VALUE lines, trimming whitespace around both sides', () => {
    const p = writeEnv('.env', 'LE_PLAIN=one\n   LE_SPACED   =   two   \n');
    loadDotEnv([p]);
    expect(process.env['LE_PLAIN']).toBe('one');
    expect(process.env['LE_SPACED']).toBe('two');
  });

  it('strips surrounding double and single quotes', () => {
    const p = writeEnv('.env', 'LE_DQ="double quoted"\nLE_SQ=\'single quoted\'\n');
    loadDotEnv([p]);
    expect(process.env['LE_DQ']).toBe('double quoted');
    expect(process.env['LE_SQ']).toBe('single quoted');
  });

  it('leaves MISMATCHED quotes alone (only a matching pair is stripped)', () => {
    const p = writeEnv('.env', 'LE_MIXED_QUOTE="unbalanced\n');
    loadDotEnv([p]);
    expect(process.env['LE_MIXED_QUOTE']).toBe('"unbalanced');
  });

  it('skips comments, blank lines and lines with no `=`', () => {
    const p = writeEnv(
      '.env',
      '# a comment\n\n   \n#LE_PLAIN=commented-out\nNOT_A_PAIR\nLE_PLAIN=kept\n',
    );
    loadDotEnv([p]);
    expect(process.env['LE_PLAIN']).toBe('kept');
    expect(process.env['NOT_A_PAIR']).toBeUndefined();
  });

  it('skips a line whose key is empty (`=value`)', () => {
    const p = writeEnv('.env', '=orphan\nLE_PLAIN=ok\n');
    loadDotEnv([p]);
    expect(process.env['LE_PLAIN']).toBe('ok');
    expect(process.env['']).toBeUndefined();
  });

  it('keeps `=` characters inside the VALUE (splits on the first one only)', () => {
    const p = writeEnv('.env', 'LE_INNER_EQ=a=b=c\n');
    loadDotEnv([p]);
    expect(process.env['LE_INNER_EQ']).toBe('a=b=c');
  });

  it('supports an empty value', () => {
    const p = writeEnv('.env', 'LE_EMPTY=\n');
    loadDotEnv([p]);
    expect(process.env['LE_EMPTY']).toBe('');
  });

  it('tolerates CRLF line endings', () => {
    const p = writeEnv('.env', 'LE_CRLF=windows\r\nLE_PLAIN=unix\n');
    loadDotEnv([p]);
    // The trim() per line removes the stray \r.
    expect(process.env['LE_CRLF']).toBe('windows');
    expect(process.env['LE_PLAIN']).toBe('unix');
  });

  it('does NOT treat an inline `#` as a comment (value keeps it)', () => {
    const p = writeEnv('.env', 'LE_HASH_INLINE=value # not-a-comment\n');
    loadDotEnv([p]);
    expect(process.env['LE_HASH_INLINE']).toBe('value # not-a-comment');
  });

  it('SHELL-provided vars win: an existing process.env key is never overwritten', () => {
    process.env['LE_SHELL_WINS'] = 'from-shell';
    const p = writeEnv('.env', 'LE_SHELL_WINS=from-file\nLE_PLAIN=from-file\n');
    loadDotEnv([p]);
    expect(process.env['LE_SHELL_WINS']).toBe('from-shell');
    // ...and the rest of the file still applies.
    expect(process.env['LE_PLAIN']).toBe('from-file');
  });

  it('shell precedence holds even for an EMPTY-string shell value', () => {
    process.env['LE_SHELL_WINS'] = '';
    loadDotEnv([writeEnv('.env', 'LE_SHELL_WINS=from-file\n')]);
    expect(process.env['LE_SHELL_WINS']).toBe('');
  });

  it('is a silent no-op when no candidate file exists', () => {
    expect(() => loadDotEnv([join(dir, 'nope', '.env'), join(dir, 'also-missing')])).not.toThrow();
    expect(process.env['LE_PLAIN']).toBeUndefined();
  });

  it('is a silent no-op for an EMPTY candidate list', () => {
    expect(() => loadDotEnv([])).not.toThrow();
  });

  it('the FIRST existing candidate wins — later files are not read at all', () => {
    const first = writeEnv('.env.first', 'LE_FROM_FIRST=yes\nLE_PLAIN=first\n');
    const second = writeEnv('.env.second', 'LE_FROM_SECOND=yes\nLE_PLAIN=second\n');
    loadDotEnv([join(dir, 'missing.env'), first, second]);
    expect(process.env['LE_FROM_FIRST']).toBe('yes');
    expect(process.env['LE_PLAIN']).toBe('first');
    expect(process.env['LE_FROM_SECOND']).toBeUndefined();
  });

  it('best-effort: an unreadable candidate (a directory) does not throw and falls through', () => {
    const dirCandidate = join(dir, 'dir-not-file');
    mkdirSync(dirCandidate);
    const real = writeEnv('.env', 'LE_PLAIN=recovered\n');
    // readFileSync on a directory throws EISDIR → caught, loop continues.
    expect(() => loadDotEnv([dirCandidate, real])).not.toThrow();
    expect(process.env['LE_PLAIN']).toBe('recovered');
  });

  it('keys are case-sensitive', () => {
    const p = writeEnv('.env', 'LE_LOWER=upper\nle_lower=lower\n');
    loadDotEnv([p]);
    expect(process.env['LE_LOWER']).toBe('upper');
    expect(process.env['le_lower']).toBe('lower');
    delete process.env['le_lower'];
  });
});

describe('defaultDotEnvPaths', () => {
  it('returns cwd/.env plus the two dir-relative candidates, in precedence order', () => {
    const paths = defaultDotEnvPaths();
    expect(paths).toHaveLength(3);
    expect(paths[0]).toBe(join(process.cwd(), '.env'));
    expect(paths.every((p) => p.endsWith('.env'))).toBe(true);
    // Candidates 2 and 3 are resolved relative to this module's directory: the
    // app dir (one up) and the repo root (three up). join() collapses the `..`
    // segments, and the repo-root path is the shorter (higher) of the two.
    expect(paths[1]).not.toContain('..');
    expect(paths[2]).not.toContain('..');
    expect(paths[2].length).toBeLessThan(paths[1].length);
    expect(paths[1].startsWith(paths[2].replace(/\.env$/, ''))).toBe(true);
  });
});
