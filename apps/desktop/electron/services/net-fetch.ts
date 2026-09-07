// Chromium-backed fetch for the Electron main process.
//
// Node's global fetch (undici) verifies TLS against only Node's bundled CA
// store and does NOT do AIA fetching, so a server that serves an incomplete
// chain (missing intermediate) or an internal-CA cert fails with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE — even when the renderer reaches it fine.
// Electron's `net.fetch` runs on Chromium's network stack: the same OS/Chromium
// trust store, AIA intermediate fetching, and system proxy the renderer uses.
//
// Routing main-process HTTP (LLM gateways, OAuth, etc.) through here keeps the
// two processes in agreement — so "renderer works, main fails" can't happen.
import { net } from 'electron';

/**
 * Drop-in replacement for global `fetch` that uses Chromium's network stack.
 * Same WHATWG signature (URL + RequestInit, returns a standard Response), so
 * callers swap `fetch(...)` → `chromiumFetch(...)` with no other changes.
 * Must be called after the app `ready` event (always true for user-triggered
 * work like sync / categorization).
 */
export function chromiumFetch(input: string, init?: RequestInit): Promise<Response> {
  return net.fetch(input, init as Parameters<typeof net.fetch>[1]);
}
