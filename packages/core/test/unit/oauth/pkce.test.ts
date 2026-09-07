import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

import { generatePkcePair, generateState } from '../../../src/oauth/pkce';

// PKCE is the only thing standing between a hijacked redirect and a stolen
// account: if the verifier loses entropy, gets reused across calls, or the
// challenge stops being base64url(SHA-256(ASCII(verifier))) with NO padding,
// every authorize request either fails at the token endpoint (users can't sign
// in at all) or becomes replayable. These assert the RFC 7636 §4.1/§4.2 shape
// as properties, never exact values, so they stay deterministic.

const RFC7636_UNRESERVED = /^[A-Za-z0-9\-._~]+$/;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('generatePkcePair — verifier', () => {
  // RFC 7636 §4.1: 43..128 chars from the unreserved set. base64url of 32
  // random bytes is exactly 43 — the minimum legal length at full entropy.
  it('is 43 chars of the RFC 7636 unreserved charset and carries 32 bytes of entropy', () => {
    const { verifier } = generatePkcePair();

    expect(verifier).toHaveLength(43);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(RFC7636_UNRESERVED);
    expect(Buffer.from(verifier, 'base64url')).toHaveLength(32); // full 256-bit entropy
  });

  // '+' / '/' / '=' from plain base64 would be percent-encoded (or silently
  // mangled) in the query string and the token endpoint would then hash a
  // different string than we sent → invalid_grant on every login.
  it('is URL-safe: no +, /, or = padding, and survives encodeURIComponent untouched', () => {
    const { verifier } = generatePkcePair();

    expect(verifier).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(verifier)).toBe(verifier);
  });

  // A repeated verifier makes the authorization code replayable by anyone who
  // observed an earlier flow. Uniqueness over many draws also catches a stubbed
  // /seeded RNG sneaking in.
  it('differs on every call (200 draws, all distinct)', () => {
    const verifiers = Array.from({ length: 200 }, () => generatePkcePair().verifier);

    expect(new Set(verifiers).size).toBe(200);
  });
});

describe('generatePkcePair — challenge', () => {
  // The exact derivation the server recomputes. Independently recomputed here
  // rather than snapshotted, so it holds for any random verifier.
  it('is base64url(SHA-256(verifier)) with no padding, and method is S256', () => {
    const { verifier, challenge, method } = generatePkcePair();

    expect(method).toBe('S256');
    expect(challenge).toBe(base64url(createHash('sha256').update(verifier).digest()));
    expect(challenge).toHaveLength(43); // 32-byte digest, unpadded
    expect(challenge).not.toMatch(/[+/=]/);
    expect(challenge).toMatch(RFC7636_UNRESERVED);
  });

  // RFC 7636 hashes ASCII(code_verifier) — the *string we transmit* — not the
  // random bytes it was encoded from. Hashing the raw bytes instead would look
  // fine locally and fail with invalid_grant against every real server.
  it('hashes the verifier STRING, not the raw random bytes behind it', () => {
    const { verifier, challenge } = generatePkcePair();
    const rawBytes = Buffer.from(verifier, 'base64url'); // the pre-encoding entropy
    const wrongChallenge = base64url(createHash('sha256').update(rawBytes).digest());

    expect(challenge).not.toBe(wrongChallenge);
    expect(challenge).toBe(base64url(createHash('sha256').update(Buffer.from(verifier, 'ascii')).digest()));
  });

  // Same input pair must always agree; two independent pairs must not collide.
  it('is deterministic per verifier but distinct across pairs', () => {
    const a = generatePkcePair();
    const b = generatePkcePair();

    expect(a.challenge).toBe(base64url(createHash('sha256').update(a.verifier).digest()));
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('generateState', () => {
  // `state` is the CSRF token for the redirect: guessable state = an attacker
  // can complete a flow into the victim's app. 16 random bytes → 22 base64url
  // chars.
  it('is 22 URL-safe chars carrying 16 bytes of entropy', () => {
    const state = generateState();

    expect(state).toHaveLength(22);
    expect(state).toMatch(RFC7636_UNRESERVED);
    expect(state).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(state)).toBe(state);
    expect(Buffer.from(state, 'base64url')).toHaveLength(16);
  });

  it('is unique across 200 calls', () => {
    const states = Array.from({ length: 200 }, () => generateState());

    expect(new Set(states).size).toBe(200);
  });

  // Cheap sanity check that the bytes are actually random rather than a
  // constant/counter: 200 samples should touch a wide slice of the alphabet.
  it('spreads across the alphabet (not a constant or counter)', () => {
    const chars = new Set(Array.from({ length: 200 }, () => generateState()).join(''));

    expect(chars.size).toBeGreaterThan(30);
  });
});
