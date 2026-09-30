import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SENDER_IDENTITY_POLICY,
  normalizeSenderIdentityPolicy,
  senderIdentityPolicyFromSettings,
} from '../../../src/utils/sender-identity-policy';

/**
 * The sender-identity policy, as the renderer reads it from the settings blob
 * and main normalises what the renderer pushed.
 *
 * What breaks if this file goes red: a picture lookup the reader switched off
 * runs anyway (Gravatar receives contact-address hashes, a brand's server is
 * asked about every sender), or one left at its default silently never runs.
 */
describe('DEFAULT_SENDER_IDENTITY_POLICY', () => {
  // Deliberate change (2026-09-30): Gravatar is ON by default, like the logos
  // and favicons. It was opt-in in 1.2.6.
  it('turns every lookup on, Gravatar included', () => {
    expect(DEFAULT_SENDER_IDENTITY_POLICY).toEqual({ logos: true, favicons: true, gravatar: true });
  });

  // Breaks if a caller mutates the shared default and every later "missing
  // value" read inherits that caller's choice.
  it('cannot be mutated through the shared reference', () => {
    expect(Object.isFrozen(DEFAULT_SENDER_IDENTITY_POLICY)).toBe(true);
  });
});

describe('normalizeSenderIdentityPolicy', () => {
  // Breaks if an explicit choice is overridden by the default (a reader who
  // turned Gravatar off gets it back on after an upgrade).
  it('keeps every explicit boolean as it is', () => {
    expect(normalizeSenderIdentityPolicy({ logos: false, favicons: false, gravatar: false }))
      .toEqual({ logos: false, favicons: false, gravatar: false });
    expect(normalizeSenderIdentityPolicy({ logos: true, favicons: false, gravatar: true }))
      .toEqual({ logos: true, favicons: false, gravatar: true });
  });

  // Breaks if a missing or malformed field reads as off (or a string "false"
  // reads as on): only a real boolean is a choice; anything else is the default.
  it('reads anything that is not a boolean as the default', () => {
    expect(normalizeSenderIdentityPolicy(null)).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(normalizeSenderIdentityPolicy(undefined)).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(normalizeSenderIdentityPolicy('junk')).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(normalizeSenderIdentityPolicy([false, false, false])).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(normalizeSenderIdentityPolicy({ logos: 'no', favicons: 0, gravatar: 'false' }))
      .toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    // A policy persisted before Gravatar had a switch has no `gravatar` key.
    expect(normalizeSenderIdentityPolicy({ logos: false, favicons: true }))
      .toEqual({ logos: false, favicons: true, gravatar: true });
  });

  // Breaks if the result aliases the frozen default, so the caller's copy
  // cannot be updated in place.
  it('returns a fresh object every time', () => {
    const a = normalizeSenderIdentityPolicy(null);
    expect(a).not.toBe(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(Object.isFrozen(a)).toBe(false);
  });
});

describe('senderIdentityPolicyFromSettings', () => {
  // Breaks if the renderer pushes a different field than the checkbox shows,
  // so the General tab says one thing and main does another.
  it('maps senderLogos / senderFavicons / contactGravatar onto the policy', () => {
    expect(senderIdentityPolicyFromSettings({ senderLogos: false, senderFavicons: true, contactGravatar: false }))
      .toEqual({ logos: false, favicons: true, gravatar: false });
    expect(senderIdentityPolicyFromSettings({ senderLogos: true, senderFavicons: false, contactGravatar: true }))
      .toEqual({ logos: true, favicons: false, gravatar: true });
  });

  // Breaks if a settings blob with no Gravatar value (every install from
  // before 1.2.6, and any blob that lost the key) keeps Gravatar off.
  it('turns Gravatar on when the blob has no value for it', () => {
    expect(senderIdentityPolicyFromSettings({ signatures: [] }).gravatar).toBe(true);
    expect(senderIdentityPolicyFromSettings({ contactGravatar: null }).gravatar).toBe(true);
  });

  // Breaks if a reader's saved "off" is read as a missing value and turned on.
  it('keeps a saved "off" off', () => {
    expect(senderIdentityPolicyFromSettings({ contactGravatar: false }).gravatar).toBe(false);
  });

  // Breaks if a corrupt or absent blob throws in the boot push instead of
  // falling back to the defaults.
  it('reads an absent or malformed blob as the defaults', () => {
    expect(senderIdentityPolicyFromSettings(null)).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(senderIdentityPolicyFromSettings('{"contactGravatar":false}')).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(senderIdentityPolicyFromSettings([])).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
  });
});
