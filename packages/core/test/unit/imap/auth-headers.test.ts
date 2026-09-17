import { describe, expect, it } from 'vitest';

import { extractAuthHeaderBlock } from '../../../src/imap/auth-headers';
import { parseAuthenticationHeaders } from '../../../src/processor/email-processor';

/**
 * Collecting the mail-authentication headers at sync time.
 *
 * What this protects: these headers are the ONLY evidence of SPF / DKIM /
 * DMARC the client ever gets, and until now they were fetched for nothing —
 * the stored verdict was parsed from an empty string and read "unknown" for
 * every message. A regex over hostile header text is exactly where a folded
 * line or an odd casing quietly turns a real "dmarc=fail" back into "unknown".
 */
const CRLF = (...lines: string[]) => lines.join('\r\n');

describe('extractAuthHeaderBlock', () => {
  it('returns undefined for an empty or absent block, never an empty string', () => {
    // An empty string would parse as a verdict of "unknown"; undefined stores
    // NULL — "no verdict recorded" — which the level treats differently.
    expect(extractAuthHeaderBlock(undefined)).toBeUndefined();
    expect(extractAuthHeaderBlock(null)).toBeUndefined();
    expect(extractAuthHeaderBlock('')).toBeUndefined();
    expect(extractAuthHeaderBlock('From: a@b.c\r\nSubject: hi')).toBeUndefined();
  });

  it('picks out Authentication-Results and leaves the rest', () => {
    const out = extractAuthHeaderBlock(CRLF(
      'From: a@b.c',
      'Authentication-Results: mx.example.com; spf=pass smtp.mailfrom=b.c; dkim=pass; dmarc=pass',
      'Subject: hi',
    ));
    expect(out).toBe('Authentication-Results: mx.example.com; spf=pass smtp.mailfrom=b.c; dkim=pass; dmarc=pass');
  });

  // THE folding case. Real servers wrap this header across several lines; the
  // old header helper had a documented bug where `$` with the m flag stopped at
  // the first physical line, truncating a multi-line value to its first token.
  it('unfolds a value continued across lines', () => {
    const out = extractAuthHeaderBlock(CRLF(
      'Authentication-Results: mx.google.com;',
      '       dkim=pass header.i=@sarv.com;',
      '       spf=pass smtp.mailfrom=sarv.com;',
      '       dmarc=pass (p=REJECT) header.from=sarv.com',
      'From: x@sarv.com',
    ));
    expect(out).toBe('Authentication-Results: mx.google.com; dkim=pass header.i=@sarv.com; spf=pass smtp.mailfrom=sarv.com; dmarc=pass (p=REJECT) header.from=sarv.com');
  });

  // One line per hop is normal; dropping all but the first would lose the
  // verdict the LAST (our own) server recorded.
  it('keeps every occurrence, one per hop', () => {
    const out = extractAuthHeaderBlock(CRLF(
      'Authentication-Results: hop1; spf=none',
      'Received: from somewhere',
      'Authentication-Results: hop2; spf=pass; dkim=pass; dmarc=pass',
    ));
    expect(out?.split('\n')).toHaveLength(2);
  });

  it('collects ARC-Authentication-Results and Received-SPF too', () => {
    const out = extractAuthHeaderBlock(CRLF(
      'ARC-Authentication-Results: i=1; mx; dkim=pass',
      'Received-SPF: pass (sender IP is 1.2.3.4)',
    ));
    expect(out).toContain('ARC-Authentication-Results: i=1; mx; dkim=pass');
    expect(out).toContain('Received-SPF: pass (sender IP is 1.2.3.4)');
  });

  it('is case-insensitive on the header name', () => {
    expect(extractAuthHeaderBlock('AUTHENTICATION-RESULTS: mx; dmarc=fail')).toContain('dmarc=fail');
  });

  // A header whose NAME merely contains the word must not match — otherwise a
  // sender could plant "X-Authentication-Results: dmarc=pass" and be believed.
  it('does not match a look-alike header name', () => {
    expect(extractAuthHeaderBlock('X-Authentication-Results: mx; dmarc=pass')).toBeUndefined();
    expect(extractAuthHeaderBlock('Old-Authentication-Results: mx; dmarc=pass')).toBeUndefined();
  });

  it('accepts a Buffer as the raw block', () => {
    expect(extractAuthHeaderBlock(Buffer.from('Authentication-Results: mx; spf=pass', 'utf8'))).toBe('Authentication-Results: mx; spf=pass');
  });
});

describe('end to end: block → stored verdict', () => {
  // The whole point: a real Gmail header block must come out as a real verdict.
  it('turns a passing Gmail block into an all-pass verdict', () => {
    const block = extractAuthHeaderBlock(CRLF(
      'Authentication-Results: mx.google.com;',
      '       dkim=pass header.i=@sarv.com header.s=google;',
      '       spf=pass (google.com: domain of x@sarv.com designates 1.2.3.4 as permitted sender);',
      '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=sarv.com',
    ));
    expect(parseAuthenticationHeaders(block)).toEqual({ spf: 'pass', dkim: 'pass', dmarc: 'pass', overall: 'pass' });
  });

  it('turns a failing block into a fail — the signal the danger level keys on', () => {
    const block = extractAuthHeaderBlock('Authentication-Results: mx; spf=fail; dkim=fail; dmarc=fail (p=REJECT)');
    expect(parseAuthenticationHeaders(block).overall).toBe('fail');
  });
});
