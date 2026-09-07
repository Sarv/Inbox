// Inline image cache — keeps base64 data URLs out of LLM prompts while
// preserving image references in extracted bodies.
//
// Why: emails carry inline images as `<img src="data:image/png;base64,...">`.
// Sending those bytes to the LLM is wasteful (1 image = 1k–10k tokens) and
// the model can't see images anyway. We replace each data URL with a short
// content-hash ref like "sarv-image:abc12345", store the original blob in
// this in-memory cache, instruct the LLM to preserve refs verbatim, then
// swap refs back for the original data URLs at render time.
//
// Durability: the cache lives only in renderer memory. On app restart the
// `conversation_extractions` rows still hold refs, but the cache is empty —
// we re-populate by walking each thread email's rawBody on chat-view open.
// rawBody is durable in DB so this is deterministic and lossless.

const REF_PREFIX = 'sarv-image:';
const cache = new Map<string, string>();

// LRU cap — background extraction can walk hundreds of image-heavy
// threads in one session; unbounded, the Map retains every base64 blob
// (hundreds of MB). Refs are re-creatable from the durable rawBody (see
// populateCacheFromHtml on thread open), so evicting old entries is safe:
// worst case a ref in a cached extraction renders as a broken image until
// its thread is reopened. Eviction is insertion-order (Map preserves it);
// registerImage re-inserts on hit so hot entries stay at the tail.
const MAX_ENTRIES = 300;
const MAX_TOTAL_CHARS = 32 * 1024 * 1024; // ~32MB of data-URL chars
let totalChars = 0;

function evictIfNeeded(): void {
  while (cache.size > MAX_ENTRIES || totalChars > MAX_TOTAL_CHARS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    totalChars -= cache.get(oldest.value)?.length ?? 0;
    cache.delete(oldest.value);
  }
}

/**
 * 8-char content hash via FNV-1a 32-bit. Fast, dependency-free, plenty of
 * collision resistance for the few-hundred-image working set we expect.
 */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Register a data URL and return the ref. Idempotent. */
export function registerImage(dataUrl: string): string {
  const id = hash(dataUrl);
  const existing = cache.get(id);
  if (existing !== undefined) {
    // Refresh recency: re-insert at the tail of the Map's insertion order.
    cache.delete(id);
    cache.set(id, existing);
    return `${REF_PREFIX}${id}`;
  }
  cache.set(id, dataUrl);
  totalChars += dataUrl.length;
  evictIfNeeded();
  return `${REF_PREFIX}${id}`;
}

/** Resolve a ref back to the original data URL, or null if missing. */
export function resolveRef(ref: string): string | null {
  if (!ref?.startsWith(REF_PREFIX)) return null;
  return cache.get(ref.slice(REF_PREFIX.length)) ?? null;
}

const DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

/**
 * Walk an HTML string, register every base64 data URL in the cache.
 * Used on thread-open to rebuild the cache from durable source rawBodies
 * so refs in cached extractions resolve correctly after app restart.
 */
export function populateCacheFromHtml(html: string | null | undefined): void {
  if (!html) return;
  const matches = html.match(DATA_URL_RE);
  if (!matches) return;
  for (const dataUrl of matches) registerImage(dataUrl);
}

/**
 * Replace `sarv-image:HASH` refs in rendered HTML with the original data
 * URLs from cache. Handles two forms the LLM might emit:
 *   • bare token in attribute or text: `sarv-image:abc12345`
 *   • markdown image after markdown→HTML: `<img src="sarv-image:abc12345">`
 * If a ref is unknown (cache miss after restart before populate ran),
 * the ref stays in place — visible as broken-image text, not a crash.
 */
export function resolveRefsInHtml(html: string): string {
  if (!html) return html;
  return html.replace(/sarv-image:([a-f0-9]{8})/g, (full, id) => {
    const dataUrl = cache.get(id);
    return dataUrl ?? full;
  });
}

/** Test/debug helper. Don't depend on this from production code. */
export function _cacheSize(): number {
  return cache.size;
}
