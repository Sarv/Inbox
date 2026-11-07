/**
 * The hosts that mean "this computer" — the only place a plain-HTTP connection
 * may go (a model server or scanner the user runs locally), because nothing
 * sent there crosses a network.
 *
 * Matched exactly, never by prefix or suffix: `localhost.evil.example` and
 * `127.0.0.1.nip.io` are someone else's computer. Hostnames are compared as
 * `URL.hostname` gives them (lower-cased, IPv6 in brackets); the bare `::1`
 * a socket reports is accepted too.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Whether `hostname` is this computer (see LOOPBACK_HOSTS). */
export function isLoopbackHost(hostname: string | null | undefined): boolean {
  return typeof hostname === 'string' && LOOPBACK_HOSTS.has(hostname.toLowerCase());
}
