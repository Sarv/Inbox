import os from 'os';
import path from 'path';

import { describe, it, expect } from 'vitest';

import { resolveWithinDir, safeFilename } from '../../../src/utils/safe-path';

// SECURITY BOUNDARY. Attachment filenames come straight off MIME headers, i.e.
// they are chosen by whoever sent the mail. A name like
// "../../../../../Library/Application Support/Sarv Inbox/db-key.bin" joined onto the
// attachment cache dir would let a hostile email overwrite the DB key. Nothing
// below is cosmetic — every case is an attempted escape or a real-world name that
// must survive. No file is ever written; these are pure path computations.

// Deliberately NOT created on disk — we only compute paths.
const BASE = path.join(os.tmpdir(), 'sarvinbox-safe-path-test');

describe('safeFilename — traversal is reduced to a single harmless segment', () => {
  it('strips POSIX directory components, keeping only the last segment', () => {
    expect(safeFilename('../../../etc/passwd')).toBe('passwd');
    expect(safeFilename('a/b/c.pdf')).toBe('c.pdf');
    expect(safeFilename('/abs/path.txt')).toBe('path.txt');
  });

  // The Windows form must be neutralised too — on POSIX `basename` does not split
  // on "\", so the sanitizer (not basename) is what has to remove the separators.
  it('leaves no path separator of EITHER flavour in the result', () => {
    for (const hostile of [
      '..\\..\\windows\\system32\\cmd.exe',
      '..\\..\\x',
      '../../../etc/passwd',
      'a/b\\c/d',
    ]) {
      const cleaned = safeFilename(hostile);
      expect(cleaned).not.toContain('/');
      expect(cleaned).not.toContain('\\');
      expect(cleaned).not.toBe('');
      // Whatever it reduced to, it must be a single segment.
      expect(path.basename(cleaned)).toBe(cleaned);
    }
  });

  // A NUL byte truncates the path at the OS layer, so "safe.txt\0../../evil" could
  // become a different file than the one we validated.
  it('strips NUL bytes and control characters', () => {
    expect(safeFilename('report\u0000.pdf')).toBe('report.pdf');
    expect(safeFilename('re\u0007port\u001b.pdf')).toBe('report.pdf');
  });

  // "." / ".." / "..." resolve to a DIRECTORY, not a file — writing to them would
  // either fail or clobber the directory entry, so they must not pass through.
  it('rejects dot-only names via the fallback', () => {
    expect(safeFilename('.')).toBe('unnamed');
    expect(safeFilename('..')).toBe('unnamed');
    expect(safeFilename('...')).toBe('unnamed');
  });

  it('falls back for empty, whitespace-only, null and undefined names', () => {
    expect(safeFilename('')).toBe('unnamed');
    expect(safeFilename('   ')).toBe('unnamed');
    expect(safeFilename(null)).toBe('unnamed');
    expect(safeFilename(undefined)).toBe('unnamed');
  });

  it('honours a caller-supplied fallback (so callers can keep an extension)', () => {
    expect(safeFilename('', 'attachment.eml')).toBe('attachment.eml');
    expect(safeFilename('/', 'attachment.eml')).toBe('attachment.eml');
  });

  // Windows reserved device names cannot be used as filenames at all.
  it('rejects Windows reserved device names', () => {
    expect(safeFilename('CON')).toBe('unnamed');
    expect(safeFilename('PRN')).toBe('unnamed');
  });

  // Legit names must NOT be mangled — over-sanitizing breaks real attachments.
  it('leaves ordinary filenames (spaces, unicode, dots) intact', () => {
    expect(safeFilename('Quarterly Report 2026.pdf')).toBe('Quarterly Report 2026.pdf');
    expect(safeFilename('rapport-financiér.xlsx')).toBe('rapport-financiér.xlsx');
    expect(safeFilename('archive.tar.gz')).toBe('archive.tar.gz');
  });

  // An over-long name makes the write fail with ENAMETOOLONG; the sanitizer caps it.
  it('truncates a pathologically long name to a writable length', () => {
    const cleaned = safeFilename(`${'x'.repeat(400)}.pdf`);
    expect(cleaned.length).toBeLessThanOrEqual(255);
    expect(cleaned.length).toBeGreaterThan(0);
  });
});

describe('resolveWithinDir — containment', () => {
  it('returns the joined absolute path for a safe name', () => {
    expect(resolveWithinDir(BASE, 'report.pdf')).toBe(path.join(BASE, 'report.pdf'));
  });

  it('allows a nested path that stays inside the base', () => {
    expect(resolveWithinDir(BASE, path.join('sub', 'report.pdf'))).toBe(path.join(BASE, 'sub', 'report.pdf'));
    // Traversal that cancels out is still inside, so it is allowed.
    expect(resolveWithinDir(BASE, path.join('sub', '..', 'report.pdf'))).toBe(path.join(BASE, 'report.pdf'));
  });

  it('THROWS on ../ traversal out of the base', () => {
    expect(() => resolveWithinDir(BASE, path.join('..', 'evil.txt'))).toThrow(/unsafe path/i);
    expect(() => resolveWithinDir(BASE, path.join('..', '..', '..', 'db-key.bin'))).toThrow(/unsafe path/i);
    expect(() => resolveWithinDir(BASE, path.join('sub', '..', '..', 'evil.txt'))).toThrow(/unsafe path/i);
  });

  // An absolute name must never be honoured — `path.resolve` discards the base
  // entirely when the second argument is absolute, which is exactly the escape.
  it('THROWS on an absolute path that would discard the base entirely', () => {
    const absolute = path.join(path.sep, 'etc', 'passwd');
    expect(() => resolveWithinDir(BASE, absolute)).toThrow(/unsafe path/i);
  });

  // The classic prefix bug: a naive `full.startsWith(base)` accepts a SIBLING
  // directory whose name merely begins with the base name. The `base + sep` check
  // is what closes it.
  it('THROWS on a sibling directory whose name shares the base as a prefix', () => {
    expect(() => resolveWithinDir(BASE, path.join('..', `${path.basename(BASE)}-evil`, 'x.txt')))
      .toThrow(/unsafe path/i);
  });

  it('includes the offending name in the error so the log is actionable', () => {
    expect(() => resolveWithinDir(BASE, path.join('..', 'evil.txt'))).toThrow(/evil\.txt/);
  });

  // The base itself is "within" the base; callers pass '' when they only want the
  // normalized dir back.
  it('returns the base itself for an empty or dot name', () => {
    expect(resolveWithinDir(BASE, '')).toBe(path.resolve(BASE));
    expect(resolveWithinDir(BASE, '.')).toBe(path.resolve(BASE));
  });

  it('normalizes a non-absolute base before comparing', () => {
    const result = resolveWithinDir(BASE, 'a.txt');
    expect(path.isAbsolute(result)).toBe(true);
  });
});

describe('safeFilename + resolveWithinDir together (the documented usage)', () => {
  // The pair is the contract: sanitize an untrusted name, then contain it. After
  // safeFilename, containment must NEVER throw — that is what makes the attachment
  // write path safe for arbitrary hostile input.
  it('never escapes the base for any hostile attachment name', () => {
    const hostile = [
      '../../../../../Library/Application Support/Sarv Inbox/db-key.bin',
      '..\\..\\..\\Windows\\System32\\config\\SAM',
      '/etc/shadow',
      'evil\u0000.txt',
      '....//....//etc/passwd',
      '',
      '.',
    ];
    for (const name of hostile) {
      const full = resolveWithinDir(BASE, safeFilename(name));
      expect(full.startsWith(path.resolve(BASE) + path.sep)).toBe(true);
      expect(path.dirname(full)).toBe(path.resolve(BASE));
    }
  });
});
