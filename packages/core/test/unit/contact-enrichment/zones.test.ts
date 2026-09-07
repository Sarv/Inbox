import { beforeAll, describe, expect, it } from 'vitest';

import { splitSignaturesWithParser } from '../../../src/contact-enrichment/signature-splitter-node';
import { segmentZones, setSignatureSplitter } from '../../../src/contact-enrichment/zones';

/**
 * Zone segmentation, with email-reply-parser as the primary segmenter.
 *
 * The library is used first because it is the proven implementation (GitHub's
 * parser, ported) and because it returns EVERY signature fragment rather than
 * only the last one. The local delimiter heuristics remain behind it for the
 * html-to-text shapes it does not recognise — verified, not assumed.
 */

describe('segmentZones with email-reply-parser', () => {
  // The parser is Node-only and therefore injected, never imported by the
  // shared module — see signature-splitter-node.ts. Tests install it the same
  // way the main process does.
  beforeAll(() => setSignatureSplitter(splitSignaturesWithParser));

  it('returns BOTH signatures when an email carries two sign-offs', () => {
    const body = [
      'text',
      '',
      '--',
      '',
      'Thanks & Regards,Mahesh Kotak',
      'Server Admin',
      '+91-9111-9111-00',
      '',
      '--',
      '',
      'Pooja Khatri',
      'CBO',
      'pkh@sarv.com || 9988776655',
    ].join('\n');

    const sigs = segmentZones(body, 'pkh@sarv.com').filter((z) => z.kind === 'signature');
    const joined = sigs.map((z) => z.text).join(' ');
    expect(sigs.length).toBeGreaterThanOrEqual(2);
    expect(joined).toContain('Mahesh');
    expect(joined).toContain('Pooja');
  });

  it('recognises an indented "--" separator from html-to-text', () => {
    const body = 'Survey link above.\n\n    --\n\n    Pooja KhatriCBOpkh@sarv.com || 9988776655';
    const zones = segmentZones(body, 'pkh@sarv.com');
    expect(zones.some((z) => z.kind === 'signature')).toBe(true);
  });

  it('falls back to local heuristics for a glued sign-off the parser misses', () => {
    const body = 'Kindly treat this as high priority.Regards,Bindu YagnikSales Manager+91 8877-6655-44';
    const zones = segmentZones(body, 'bindu.y@sarv.com');
    expect(zones.some((z) => z.kind === 'signature')).toBe(true);
  });

  it('separates a quoted reply and names its author', () => {
    const body = [
      'Please review.',
      '',
      '--',
      'Pooja Khatri',
      'Mobile: 9988776655',
      '',
      'On Wed, 29 Jul 2026, Bindu Yagnik <bindu.y@sarv.com> wrote:',
      '',
      'Sharing the deck.',
      '+91 88776 65544',
    ].join('\n');

    const zones = segmentZones(body, 'pkh@sarv.com');
    const quoted = zones.find((z) => z.kind === 'quoted');
    expect(quoted?.author).toBe('bindu.y@sarv.com');
    expect(quoted?.text).not.toContain('9988776655');
  });

  it('does not throw on blank or malformed input', () => {
    expect(() => segmentZones('   ', 'a@b.com')).not.toThrow();
    expect(segmentZones('', 'a@b.com')).toEqual([]);
  });
});
