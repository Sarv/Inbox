import { describe, expect, it } from 'vitest';

import { isVerifiedSender, pickSenderAvatar } from '../../../../src/utils/sender-avatar';

/**
 * Which picture stands for a sender, and when the blue tick shows.
 *
 * What this protects: the priority order IS the privacy and security model of
 * the avatar. A BIMI logo on a message that failed DMARC puts the brand on
 * the phish; a tick without DMARC says "this really came from them" about a
 * message that may not have. Both are one inverted condition away.
 */
const all = { bimiStatus: 'verified' as const, bimiLogo: 'data:logo', dmarcPass: true, contactPhoto: 'data:photo', favicon: 'data:fav' };

describe('pickSenderAvatar', () => {
  it('prefers the BIMI logo on a DMARC pass, drawn whole on white', () => {
    expect(pickSenderAvatar(all)).toEqual({ src: 'data:logo', source: 'bimi', fit: 'contain' });
    expect(pickSenderAvatar({ ...all, bimiStatus: 'logo' }).source).toBe('bimi');
  });

  // THE rule: no DMARC pass, no brand logo — whatever the domain publishes.
  it('withholds the logo when the message did not pass DMARC, falling through to the photo', () => {
    expect(pickSenderAvatar({ ...all, dmarcPass: false })).toEqual({ src: 'data:photo', source: 'contact', fit: 'cover' });
  });

  it('ignores BIMI standings that carry no logo', () => {
    for (const status of ['declined', 'none', 'invalid', 'error', null] as const) {
      expect(pickSenderAvatar({ ...all, bimiStatus: status, bimiLogo: null }).source).toBe('contact');
    }
    expect(pickSenderAvatar({ ...all, bimiLogo: null }).source).toBe('contact');
  });

  it('falls back from photo to favicon to initials', () => {
    expect(pickSenderAvatar({ ...all, bimiStatus: null, contactPhoto: null })).toEqual({ src: 'data:fav', source: 'favicon', fit: 'contain' });
    expect(pickSenderAvatar({ bimiStatus: null, bimiLogo: null, dmarcPass: false, contactPhoto: null, favicon: null }))
      .toEqual({ src: null, source: 'initials', fit: 'cover' });
  });
});

describe('isVerifiedSender', () => {
  it('needs both a verified certificate and a DMARC pass', () => {
    expect(isVerifiedSender({ bimiStatus: 'verified', dmarcPass: true })).toBe(true);
    expect(isVerifiedSender({ bimiStatus: 'verified', dmarcPass: false })).toBe(false);
    expect(isVerifiedSender({ bimiStatus: 'logo', dmarcPass: true })).toBe(false);
    expect(isVerifiedSender({ bimiStatus: null, dmarcPass: true })).toBe(false);
  });
});
