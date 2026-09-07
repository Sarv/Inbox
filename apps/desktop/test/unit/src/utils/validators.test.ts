import { describe, expect, it } from 'vitest';

import { isValidEmail } from '../../../../src/utils/validators';

// This is the renderer-local mirror of core's isValidEmail. It exists so the
// renderer can validate addresses WITHOUT importing `@sarvinbox/core` — that
// barrel pulls mailparser → `require('stream')` into the browser bundle and
// throws "Dynamic require of 'stream' is not supported", blanking the whole
// renderer. If someone "simplifies" identities.ts back to the core import, the
// app breaks at load; these tests document the contract this file must keep.
describe('renderer isValidEmail (core mirror)', () => {
  it('accepts well-formed addresses', () => {
    // Regression: the compose From-picker and alias editor must accept real
    // addresses — validating here is what keeps the core barrel out of the bundle.
    expect(isValidEmail('me@example.com')).toBe(true);
    expect(isValidEmail('First.Last+tag@sub.example.co')).toBe(true);
  });

  it('rejects malformed addresses', () => {
    // Regression: a garbage alias must never pass validation into a From header.
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
  });
});
