/**
 * Leaving a mailing list: reading `List-Unsubscribe` (RFC 2369) and
 * `List-Unsubscribe-Post` (RFC 8058).
 *
 * Pure and zero-dependency, so the renderer can alias it straight in and decide
 * what the Unsubscribe button does with the SAME rules the main process uses to
 * carry it out. A renderer that offered one-click and a main process that then
 * opened a browser page would be two different promises to the reader.
 *
 * Both headers are stored verbatim on the message (migration v93) and parsed
 * here at read time, so improving this parser improves every message already in
 * the mailbox rather than only the next sync's.
 *
 * ## The header
 *
 *     List-Unsubscribe: <https://brand.example/u/abc>, <mailto:u@brand.example?subject=unsub>
 *
 * A comma-separated list of URIs in angle brackets, in NO guaranteed order, and
 * folded across lines by any sender whose entries are long. Everything outside
 * the brackets — whitespace, a stray comment, a sender's non-standard note — is
 * not addressing and is discarded.
 *
 * ## One-click (RFC 8058)
 *
 *     List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * Its presence, together with an https entry, is the sender's promise that a
 * POST of exactly that body to exactly that URL unsubscribes with no further
 * interaction — no page, no login, no confirmation. Without the header the https
 * entry is a PAGE to open, not an endpoint to post to: posting to it anyway is
 * an unauthenticated write to a URL that never agreed to receive one.
 *
 * ## Why no regex-heavy parse
 *
 * The bracketed-list grammar is small enough to walk directly, and walking it
 * means a malformed header degrades to "the entries I could read" instead of
 * matching nothing (or backtracking). No mailing-list-header library in the
 * ecosystem is both maintained and narrower than this file.
 */

/** What a message offers as a way off the list. */
export interface UnsubscribeTarget {
  /** The https(s) entry — a one-click endpoint or a page, see `oneClick`. */
  httpUrl: string | null;
  /** The `mailto:` entry, addressing included (`?subject=`, `?body=`). */
  mailtoUri: string | null;
  /** The sender promises RFC 8058 one-click: POST the body, done. */
  oneClick: boolean;
}

/** The exact request body RFC 8058 requires for a one-click unsubscribe. */
export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';

const NOTHING: UnsubscribeTarget = { httpUrl: null, mailtoUri: null, oneClick: false };

/**
 * Every `<...>` entry in a List-Unsubscribe header value, in order, trimmed.
 *
 * Walks the string rather than splitting on commas: a comma inside a URI (a
 * `?subject=a,b` query, say) is part of that entry, and splitting first would
 * cut it in half. Unclosed final bracket = an entry that was never completed,
 * so it is dropped rather than guessed at.
 */
export function unsubscribeEntries(header: string | null | undefined): string[] {
  if (!header) return [];
  const entries: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of header) {
    if (char === '<') {
      // A nested '<' cannot start a URI; keep it as content so a malformed
      // entry is still readable rather than silently truncated.
      if (depth > 0) current += char;
      depth += 1;
      continue;
    }
    if (char === '>') {
      depth -= 1;
      if (depth <= 0) {
        depth = 0;
        const entry = current.trim();
        if (entry) entries.push(entry);
        current = '';
        continue;
      }
      current += char;
      continue;
    }
    if (depth > 0) current += char;
  }
  return entries;
}

/** True when the value is an absolute http(s) URL we are willing to act on. */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value);
}

/** True when the sender declared RFC 8058 one-click on this message. */
export function declaresOneClick(postHeader: string | null | undefined): boolean {
  if (!postHeader) return false;
  // Case-insensitive and whitespace-tolerant: the value is a fixed token, and
  // senders emit it with varied spacing around the '='.
  return postHeader.toLowerCase().replace(/\s+/g, '').includes('list-unsubscribe=one-click');
}

/**
 * The unsubscribe options a message offers, from its two stored headers.
 *
 * `oneClick` is only ever true alongside an https URL, because a one-click
 * declaration with nothing to POST to is not actionable — treating it as
 * actionable is how a button reports success having done nothing.
 */
export function parseUnsubscribe(
  listUnsubscribe: string | null | undefined,
  listUnsubscribePost?: string | null,
): UnsubscribeTarget {
  const entries = unsubscribeEntries(listUnsubscribe);
  if (entries.length === 0) return NOTHING;

  // Prefer the FIRST of each kind: senders list their preferred route first,
  // and a second https entry is usually a tracking mirror of the same action.
  const httpUrl = entries.find(isHttpUrl) ?? null;
  const mailtoUri = entries.find((entry) => /^mailto:\S/i.test(entry)) ?? null;

  return {
    httpUrl,
    mailtoUri,
    // https ONLY, even though `httpUrl` may be plain http. A one-click POST
    // carries the sender's unsubscribe token as its target, and replaying that
    // token over a cleartext hop hands anyone on the path the ability to
    // unsubscribe this reader from anything that link covers. An http entry is
    // still a perfectly good PAGE to open — the browser shows the reader what
    // it is — so it degrades to that rather than disappearing.
    oneClick: !!httpUrl && /^https:/i.test(httpUrl) && declaresOneClick(listUnsubscribePost),
  };
}

/** Whether a message offers any way to unsubscribe at all. */
export function canUnsubscribe(target: UnsubscribeTarget): boolean {
  return !!target.httpUrl || !!target.mailtoUri;
}

/** The recipient and subject of a `mailto:` unsubscribe, for the outgoing mail. */
export interface MailtoUnsubscribe {
  to: string;
  subject: string;
  body: string;
}

/**
 * Turn a `mailto:` entry into the message to send.
 *
 * The URI carries its own subject/body when the sender cares what they are
 * (some list managers key on the subject), so those win; otherwise we send the
 * conventional "unsubscribe". Percent-decoding is `decodeURIComponent`'s job,
 * and a value it rejects falls back to the raw text rather than throwing on a
 * user action.
 */
export function mailtoUnsubscribe(mailtoUri: string | null | undefined): MailtoUnsubscribe | null {
  if (!mailtoUri) return null;
  const withoutScheme = mailtoUri.replace(/^mailto:/i, '');
  const [addressPart, queryPart = ''] = splitOnce(withoutScheme, '?');
  const to = decodeOrRaw(addressPart).trim();
  if (!to || !to.includes('@')) return null;

  const params = new URLSearchParams(queryPart);
  return {
    to,
    subject: params.get('subject')?.trim() || 'unsubscribe',
    body: params.get('body')?.trim() || 'unsubscribe',
  };
}

/** Split on the FIRST occurrence only — a query string may contain more. */
function splitOnce(value: string, separator: string): [string, string?] {
  const index = value.indexOf(separator);
  return index === -1 ? [value] : [value.slice(0, index), value.slice(index + 1)];
}

function decodeOrRaw(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Which of the three ways off a list a caller is asking for. */
export type UnsubscribeRoute = 'one-click' | 'page' | 'mailto';

/** A route resolved against what the message actually offers, ready to carry out. */
export type UnsubscribeAction =
  | { kind: 'one-click'; url: string; body: string }
  | { kind: 'page'; url: string }
  | { kind: 'mailto'; mail: MailtoUnsubscribe };

/**
 * The best route this message offers, or null when it offers none.
 *
 * One-click first because it is the only route that finishes without leaving
 * the app; a page next, because a form the reader submits still works; mailto
 * last, since a list manager that only reads mail is the slowest to act and the
 * one most likely to have gone away.
 */
export function preferredRoute(target: UnsubscribeTarget): UnsubscribeRoute | null {
  if (target.oneClick && target.httpUrl) return 'one-click';
  if (target.httpUrl) return 'page';
  if (target.mailtoUri) return 'mailto';
  return null;
}

/**
 * Resolve a requested route against the message's OWN stored headers.
 *
 * This is the security boundary between the window and the main process, and
 * the reason it takes headers rather than a URL: the renderer says which route
 * the reader chose, never where to send them. Handed a URL directly, an
 * `unsubscribe` IPC would POST — unauthenticated, from the reader's network —
 * to anywhere a crafted message could name. Here the address can only ever come
 * from the header the sender themselves set.
 *
 * Returns null when the message does not offer the route asked for, including
 * the case that matters most: `one-click` on a message with no
 * `List-Unsubscribe-Post`, where the https entry is a page to open and posting
 * to it is a write it never agreed to receive.
 */
export function resolveUnsubscribeAction(
  listUnsubscribe: string | null | undefined,
  listUnsubscribePost: string | null | undefined,
  route: UnsubscribeRoute,
): UnsubscribeAction | null {
  const target = parseUnsubscribe(listUnsubscribe, listUnsubscribePost);

  if (route === 'one-click') {
    return target.oneClick && target.httpUrl
      ? { kind: 'one-click', url: target.httpUrl, body: ONE_CLICK_BODY }
      : null;
  }
  if (route === 'page') {
    return target.httpUrl ? { kind: 'page', url: target.httpUrl } : null;
  }
  const mail = mailtoUnsubscribe(target.mailtoUri);
  return mail ? { kind: 'mailto', mail } : null;
}
