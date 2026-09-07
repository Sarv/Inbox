import { describe, it, expect } from 'vitest';

import { OAUTH_IMAP_PRESETS, oauthImapPreset } from '../../../src/utils/oauth-imap-presets';

// The durable OAuth record stores only { provider, email, tokens } — no host. This
// mapping is how main rebuilds a full account identity (and therefore the
// deterministic accountIdFor id, the vault key and the per-account DB filename)
// after a lost renderer localStorage. A wrong host here silently re-keys an
// existing account onto a NEW database.

describe('oauthImapPreset', () => {
  it('returns the IMAP host/port for each mail provider', () => {
    expect(oauthImapPreset('gmail')).toEqual({ host: 'imap.gmail.com', port: 993, secure: true });
    expect(oauthImapPreset('microsoft')).toEqual({ host: 'outlook.office365.com', port: 993, secure: true });
    expect(oauthImapPreset('yahoo')).toEqual({ host: 'imap.mail.yahoo.com', port: 993, secure: true });
  });

  // 'sarv' is a sign-in / AI identity provider, NOT a mail provider — it must not
  // resolve to some default host and get seeded as a mail account.
  it('returns null for the sarv sign-in provider', () => {
    expect(oauthImapPreset('sarv')).toBeNull();
  });

  it('returns null for unknown and empty provider ids', () => {
    expect(oauthImapPreset('protonmail')).toBeNull();
    expect(oauthImapPreset('')).toBeNull();
    expect(oauthImapPreset('GMAIL')).toBeNull(); // ids are lowercase, no fuzzy matching
  });
});

describe('OAUTH_IMAP_PRESETS', () => {
  // Every OAuth mail provider must use implicit TLS on 993; a plaintext port here
  // would send the OAuth bearer token in the clear.
  it('uses implicit TLS on port 993 for every preset', () => {
    const presets = Object.values(OAUTH_IMAP_PRESETS);
    expect(presets.length).toBeGreaterThan(0);
    for (const preset of presets) {
      expect(preset?.port).toBe(993);
      expect(preset?.secure).toBe(true);
      expect(preset?.host).toMatch(/^[a-z0-9.-]+$/);
    }
  });

  it('exposes exactly the three OAuth mail providers', () => {
    expect(Object.keys(OAUTH_IMAP_PRESETS).sort()).toEqual(['gmail', 'microsoft', 'yahoo']);
  });

  // The table and the lookup must never disagree — the lookup is what main calls.
  it('agrees with the lookup helper for every entry', () => {
    for (const [provider, preset] of Object.entries(OAUTH_IMAP_PRESETS)) {
      expect(oauthImapPreset(provider)).toEqual(preset);
    }
  });
});
