/**
 * 32-bit FNV-1a over a string's UTF-16 code units — zero imports, so it is safe
 * in the renderer (see `apps/desktop/vite/renderer-aliases.ts`).
 *
 * Meant to be the ONE implementation. It was written out twice — the
 * read-model's `stateVersion` (thread-rollup, which now imports this) and the
 * duplicate-message bucket key (renderer `utils/duplicate-messages.ts`
 * `cheapHash`) — and it is now also the first-email split's source
 * fingerprint. The renderer copy is NOT folded yet (that file was under
 * concurrent edit): it should import this through the `@sarvinbox/core/fnv1a`
 * alias as `fnv1a32(s).toString(36)`, which `fnv1a.test.ts` pins. Until then
 * there are two copies. Copies of a hash do not fail loudly when one drifts:
 * every comparison against a value the other copy wrote simply stops
 * matching, which reads as "the thread changed" (a read-model rebuild storm)
 * or "the cached split is stale" (an AI re-run on every open).
 *
 * Not a cryptographic hash and never used as one: callers either confirm a
 * bucket hit with an exact comparison, or pair it with the input length (see
 * {@link fnv1aFingerprint}) as a cheap change detector.
 *
 * Code units, not UTF-8 bytes: the value only ever has to agree with itself.
 * For ASCII input it equals the published FNV-1a test vectors.
 */
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** {@link fnv1a32} as 8 lower-case hex digits (zero-padded, fixed width). */
export function fnv1a32Hex(str: string): string {
  return fnv1a32(str).toString(16).padStart(8, '0');
}

/**
 * `${length}:${fnv1a32Hex}` — a change detector for a stored body.
 *
 * The length rides along so that the (rare) 32-bit collision also has to agree
 * on size before two different inputs read as the same one.
 */
export function fnv1aFingerprint(str: string): string {
  return `${str.length}:${fnv1a32Hex(str)}`;
}
