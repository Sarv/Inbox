/**
 * Preferred loopback ports for the mail/Sarv OAuth callback listener
 * (oauth-service.ts). Tried in order, every time the listener opens, until one
 * binds. They must all be registered as allowed redirect_uris on the provider
 * (Sarv does strict exact-match; Google accepts any):
 *   http://127.0.0.1:51823/cb
 *   http://127.0.0.1:51824/cb
 *   http://127.0.0.1:51825/cb
 * If all three are held by another process the listener falls back to an
 * ephemeral port; a strict server then answers redirect_uri_mismatch and the
 * user has to free one of the preferred ports.
 *
 * A module of its own so a test suite can give each file its own ports: the
 * listener now opens and closes with every sign-in, and two test files racing
 * for 51823 in parallel would each see the other's socket.
 */
export const OAUTH_CALLBACK_PORTS: readonly number[] = [51823, 51824, 51825];
