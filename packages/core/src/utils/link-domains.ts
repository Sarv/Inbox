/**
 * The domains a message LINKS to — the input of the spam filter's body stage.
 *
 * A phish rarely comes from a listed domain; it links to one. So once a body
 * has been downloaded, every http(s) link target is reduced to its registrable
 * domain and handed to the reputation provider like a sender domain would be.
 * HTML bodies are parsed (htmlparser2), not pattern-matched: an `href` split
 * by entities or quoted oddly is exactly the shape a spammer reaches for.
 * Plain-text bodies use the same URL finder the bulk-mail classifier uses.
 *
 * Bounded on purpose: a newsletter links to a hundred things and a spam blast
 * to a thousand; the first `max` distinct domains, in document order, are the
 * ones a reader would meet first. The sender's own domain is skipped — the
 * sender stage already judged it.
 */
import { Parser } from 'htmlparser2';

import { urlsIn } from './bulk-mail';
import { registrableDomain } from './sender-spoof';

/** Distinct link domains looked up per message. */
export const LINK_DOMAINS_MAX = 20;

export interface ExtractLinkDomainsOptions {
  /** Registrable domains to leave out — the sender's own. */
  exclude?: readonly (string | null | undefined)[];
  max?: number;
}

const looksLikeHtml = (body: string): boolean => /<[a-z!/]/i.test(body);

function hrefsFromHtml(html: string): string[] {
  const out: string[] = [];
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        if (tag === 'a' || tag === 'area') {
          const href = (attribs.href || '').trim();
          if (href) out.push(href);
        } else if (tag === 'form') {
          const action = (attribs.action || '').trim();
          if (action) out.push(action);
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();
  return out;
}

function domainOfUrl(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return registrableDomain(url.hostname);
}

/** The registrable domains a body links to, deduplicated, in document order. */
export function extractLinkDomains(rawBody: string | null | undefined, opts: ExtractLinkDomainsOptions = {}): string[] {
  const body = rawBody || '';
  if (!body.trim()) return [];
  const max = opts.max ?? LINK_DOMAINS_MAX;
  const excluded = new Set((opts.exclude ?? []).map((d) => (d || '').toLowerCase()).filter(Boolean));
  const candidates = looksLikeHtml(body) ? hrefsFromHtml(body) : urlsIn(body).map((u) => u.toString());
  const out: string[] = [];
  for (const c of candidates) {
    if (out.length >= max) break;
    const domain = domainOfUrl(c);
    if (!domain || excluded.has(domain) || out.includes(domain)) continue;
    out.push(domain);
  }
  return out;
}
