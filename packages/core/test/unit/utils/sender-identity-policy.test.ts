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
 * runs anyway (Gravatar receives contact-address hashes without opt-in,
 * or a brand's server is asked after being switched off).
 */
describe('DEFAULT_SENDER_IDENTITY_POLICY', () => {
  // Breaks if a fresh profile sends contact-address hashes before opt-in.
  it('keeps Gravatar off while logo and favicon lookups default on', () => {
    expect(DEFAULT_SENDER_IDENTITY_POLICY).toEqual({ logos: true, favicons: true, gravatar: false });
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

  // Breaks if a missing or malformed field changes the default (for
  // example, a string "true" enabling Gravatar): only a boolean is a choice.
  it('reads anything that is not a boolean as the default', () => {
    expect(normalizeSenderIdentityPolicy(null)).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(normalizeSenderIdentityPolicy(undefined)).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(normalizeSenderIdentityPolicy('junk')).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(normalizeSenderIdentityPolicy([false, false, false])).toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    expect(normalizeSenderIdentityPolicy({ logos: 'no', favicons: 0, gravatar: 'true' }))
      .toEqual(DEFAULT_SENDER_IDENTITY_POLICY);
    // A policy persisted before Gravatar had a switch has no `gravatar` key.
    expect(normalizeSenderIdentityPolicy({ logos: false, favicons: true }))
      .toEqual({ logos: false, favicons: true, gravatar: false });
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

  // Breaks if a settings blob with no Gravatar choice sends hashes.
  it('keeps Gravatar off when the blob has no value for it', () => {
    expect(senderIdentityPolicyFromSettings({ signatures: [] }).gravatar).toBe(false);
    expect(senderIdentityPolicyFromSettings({ contactGravatar: null }).gravatar).toBe(false);
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
