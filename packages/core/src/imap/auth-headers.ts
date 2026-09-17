/**
 * Pull the mail-authentication headers out of a raw header block.
 *
 * `Authentication-Results` (RFC 8601) is where the RECEIVING server records
 * its SPF / DKIM / DMARC verdicts; `ARC-Authentication-Results` carries them
 * across forwarders, and `Received-SPF` is the older SPF-only form. They are
 * the only evidence of authentication the client ever sees.
 *
 * Every occurrence is kept, not just the first: a message that crossed several
 * hops has one line per hop, and the parser downstream treats the whole block
 * as one text. Folded continuation lines are unfolded into one line each.
 *
 * @returns the matching headers as `name: value` lines, or undefined when the
 *   block has none — so the caller stores NULL ("no verdict recorded") rather
 *   than an empty string that would parse as a verdict of "unknown".
 */
export function extractAuthHeaderBlock(rawHeaders: string | Buffer | undefined | null): string | undefined {
  if (!rawHeaders) return undefined;
  const text = typeof rawHeaders === 'string' ? rawHeaders : rawHeaders.toString('utf8');
  // Header name anchored at the start of the block or after a newline; value
  // runs until the next UNFOLDED newline (one not followed by whitespace).
  const re = /(?:^|\r?\n)((?:arc-)?authentication-results|received-spf):[ \t]*([\s\S]*?)(?=\r?\n(?![ \t])|$)/gi;
  const lines: string[] = [];
  for (const m of text.matchAll(re)) {
    const value = m[2].replace(/\r?\n[ \t]+/g, ' ').trim();
    if (value) lines.push(`${m[1]}: ${value}`);
  }
  return lines.length ? lines.join('\n') : undefined;
}
