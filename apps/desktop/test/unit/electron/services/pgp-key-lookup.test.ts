import type { FetchLike } from '@sarvinbox/core';
import { generateKeyPair, keyserverUrl, readAnyKey, wkdUrls } from '@sarvinbox/core/pgp';
import { beforeAll, describe, expect, it } from 'vitest';

import { MAX_KEY_BYTES, lookupPublicKey } from '../../../../electron/services/pgp-key-lookup';

/**
 * Network key discovery. What this protects: mail encrypted to a key a
 * directory returned for somebody ELSE's address; a lookup to the third-party
 * keyserver the user never allowed; and a domain without an `openpgpkey.`
 * subdomain (most of them) being remembered as "lookup failed" instead of
 * falling through to the direct WKD URL.
 */
const EMAIL = 'alice@example.org';
let aliceBinary: Uint8Array;
let aliceFingerprint: string;
let malloryBinary: Uint8Array;

beforeAll(async () => {
  const alice = await generateKeyPair({ name: 'Alice', email: EMAIL });
  const mallory = await generateKeyPair({ name: 'Mallory', email: 'mallory@evil.example' });
  aliceBinary = (await readAnyKey(alice.armoredPublicKey)).write();
  aliceFingerprint = alice.info.fingerprint;
  malloryBinary = (await readAnyKey(mallory.armoredPublicKey)).write();
});

type Reply = Uint8Array | string | number | Error;
/** A fake fetch answering per URL: bytes/text → 200, a number → that status, an Error → thrown. */
const fakeFetch = (routes: Record<string, Reply>, calls: string[] = []): FetchLike => async (url) => {
  calls.push(url);
  const reply = routes[url] ?? 404;
  if (reply instanceof Error) throw reply;
  const status = typeof reply === 'number' ? reply : 200;
  const body = typeof reply === 'string' ? new TextEncoder().encode(reply) : typeof reply === 'number' ? new Uint8Array() : reply;
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: () => null },
    arrayBuffer: async () => body.slice().buffer,
  };
};

describe('lookupPublicKey', () => {
  const wkd = () => wkdUrls(EMAIL)!;

  // Breaks: a domain without the advanced subdomain reported "failed" and never reached the direct URL.
  it('falls back from an unreachable advanced WKD host to the direct URL', async () => {
    const result = await lookupPublicKey(
      EMAIL,
      { wkd: true, keyserver: false },
      fakeFetch({ [wkd().advanced]: new Error('ENOTFOUND'), [wkd().direct]: aliceBinary }),
    );
    expect(result).toMatchObject({ failed: false, key: { source: 'wkd', fingerprint: aliceFingerprint } });
    expect(result.key?.armoredPublicKey).toContain('BEGIN PGP PUBLIC KEY BLOCK');
  });

  // Breaks: the advanced URL, when present, was not preferred as the draft specifies.
  it('uses the advanced URL first when it answers', async () => {
    const calls: string[] = [];
    await lookupPublicKey(EMAIL, { wkd: true, keyserver: true }, fakeFetch({ [wkd().advanced]: aliceBinary }, calls));
    expect(calls).toEqual([wkd().advanced]);
  });

  // Breaks: a directory's answer for somebody else's address became this recipient's key.
  it('rejects a key whose user IDs do not carry the address', async () => {
    const result = await lookupPublicKey(EMAIL, { wkd: true, keyserver: false }, fakeFetch({ [wkd().direct]: malloryBinary }));
    expect(result).toEqual({ key: null, failed: false });
  });

  // Breaks: a catch-all host's HTML 200 page threw out of discovery instead of reading as "no key".
  it('treats a body that is not a key as not found', async () => {
    const result = await lookupPublicKey(EMAIL, { wkd: true, keyserver: false }, fakeFetch({ [wkd().direct]: '<html>hi</html>' }));
    expect(result).toEqual({ key: null, failed: false });
  });

  // Breaks: an oversized (certification-spam) key was downloaded and parsed in full.
  it('ignores an oversized body', async () => {
    const huge = new Uint8Array(MAX_KEY_BYTES + 1);
    const result = await lookupPublicKey(EMAIL, { wkd: true, keyserver: false }, fakeFetch({ [wkd().direct]: huge }));
    expect(result).toEqual({ key: null, failed: false });
  });

  // Breaks: the user's address reached keys.openpgp.org without their opt-in.
  it('asks the keyserver only when allowed', async () => {
    const calls: string[] = [];
    await lookupPublicKey(EMAIL, { wkd: true, keyserver: false }, fakeFetch({}, calls));
    expect(calls).not.toContain(keyserverUrl(EMAIL));
    const result = await lookupPublicKey(EMAIL, { wkd: false, keyserver: true }, fakeFetch({ [keyserverUrl(EMAIL)]: aliceBinary }, calls));
    expect(result.key?.source).toBe('keyserver');
    expect(calls.at(-1)).toBe(keyserverUrl(EMAIL));
  });

  // Breaks: an outage was cached as "no key" for an hour instead of briefly.
  it('reports failed when the direct WKD URL or the keyserver cannot be reached', async () => {
    const down = new Error('ETIMEDOUT');
    expect(
      await lookupPublicKey(EMAIL, { wkd: true, keyserver: false }, fakeFetch({ [wkd().advanced]: down, [wkd().direct]: down })),
    ).toEqual({ key: null, failed: true });
    expect(await lookupPublicKey(EMAIL, { wkd: false, keyserver: true }, fakeFetch({ [keyserverUrl(EMAIL)]: down }))).toEqual({
      key: null,
      failed: true,
    });
  });

  // Breaks: a malformed address (no @) produced a request to a nonsense URL.
  it('asks nobody for an address without a domain, or with lookups off', async () => {
    const calls: string[] = [];
    expect(await lookupPublicKey('nobody', { wkd: true, keyserver: true }, fakeFetch({}, calls))).toEqual({ key: null, failed: false });
    expect(await lookupPublicKey(EMAIL, { wkd: false, keyserver: false }, fakeFetch({}, calls))).toEqual({ key: null, failed: false });
    expect(calls).toEqual([]);
  });
});
