import { describe, expect, it } from 'vitest';

import { errorClassName } from '../../../src/utils/error-class-name';

// errorClassName is what a log line says about a failure whose message may hold
// secret data (a decrypted payload quoted by JSON.parse, a keychain's refusal).
describe('errorClassName', () => {
  // Breaks: the log loses which kind of failure it was (SyntaxError vs a
  // keychain error), or a custom error's own name is replaced by "Error".
  it('names an Error by its class, never its message', () => {
    let parseError: unknown;
    try {
      JSON.parse('{"password":"hunter2"');
    } catch (error) {
      parseError = error;
    }
    expect(errorClassName(parseError)).toBe('SyntaxError');
    expect(errorClassName(new Error('secret text'))).toBe('Error');
    class KeychainDenied extends Error {
      override name = 'KeychainDenied';
    }
    expect(errorClassName(new KeychainDenied('access denied for hunter2'))).toBe('KeychainDenied');
  });

  // Breaks: a thrown string or object (some native bindings throw those) is
  // echoed into the log whole — the very text this helper exists to keep out.
  it('names a non-Error throw by its type, not its content', () => {
    expect(errorClassName('hunter2')).toBe('string');
    expect(errorClassName({ secret: 'hunter2' })).toBe('object');
    expect(errorClassName(undefined)).toBe('undefined');
  });
});
