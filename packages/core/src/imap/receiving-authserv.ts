/**
 * Whose `Authentication-Results` to believe, per mail provider.
 *
 * `Authentication-Results` is plain text: a sender can type
 * `Authentication-Results: mx.google.com; dmarc=pass` into their own message.
 * RFC 8601 answers that with the authserv-id — the name the RECEIVING server
 * stamps at the start of the header it writes, and whose forgeries it must
 * strip from incoming mail. Told that name, mailguard believes only that
 * server's verdicts (see `parseAuthenticationHeaders`); without it, only the
 * topmost header, which is the receiving server's on every mainstream provider
 * but is a convention rather than a guarantee.
 *
 * So this table holds only names that are FIXED and CERTAIN. A wrong entry is
 * not harmless: every message on that provider would then have no trusted
 * verdict and read as unverified. Providers whose receiving servers stamp
 * per-host names (Yahoo's `atlasNNN….yahoo.com`, Fastmail's
 * `mxN.messagingengine.com`) or none at all (Microsoft 365) are deliberately
 * absent and fall back to the topmost header.
 *
 * Keyed by the IMAP host the account connects to, because that is the one
 * thing every account has and it names the provider: a Google Workspace
 * domain still reads its mail from imap.gmail.com.
 */
const RECEIVING_AUTHSERV: ReadonlyMap<string, readonly string[]> = new Map([
  ['imap.gmail.com', ['mx.google.com']],
  ['imap.googlemail.com', ['mx.google.com']],
]);

/**
 * The authserv-id(s) the provider behind `imapHost` stamps on the mail it
 * receives, or undefined when it is not known — which means "believe the
 * topmost header", never "believe nothing".
 */
export function receivingAuthserv(imapHost: string | null | undefined): readonly string[] | undefined {
  if (!imapHost) return undefined;
  const host = imapHost.trim().toLowerCase().replace(/\.$/, '');
  return RECEIVING_AUTHSERV.get(host);
}
