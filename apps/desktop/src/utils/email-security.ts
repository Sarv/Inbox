// The ONE place an email's security level is decided.
//
// Renderer-local for the same reason as phishing.ts: the core barrel drags
// Node-only modules into the browser bundle. Pure — no DOM beyond what
// phishing.ts already needs, no store access — so the level a tooltip shows,
// the level a banner escalates on, and the level the Security page explains
// can never be three different answers.
//
// Two very different kinds of evidence feed it, and the level is honest about
// which it has:
//
//   AUTHENTICATION — SPF / DKIM / DMARC as the receiving server recorded them
//   in Authentication-Results. This is the only AUTHORITATIVE signal: it says
//   whether the sending domain really sent the mail. Absent for many small
//   senders, which is "unverifiable", not "suspicious".
//
//   HEURISTICS — display-name impersonation and links whose text names one
//   domain while the href goes to another. High-signal tells, but tells, not
//   proof; the user's trust list can retire a pair they have vetted.
//
//   SPAM FILTER — the header-stage score the sync computed when the message
//   arrived (core utils/spam-signals), read back from the row. Not recomputed
//   here: the headers it needs are not stored, and the verdict shown must be
//   the verdict that filed the message.

import { parseSpamReasons, spamVerdict, type SpamReason, type SpamVerdict } from '@sarvinbox/core/spam-verdict';

import type { LinkMismatch } from './phishing';
import { assessSender, linkMismatches, registrableDomain } from './phishing';

/** Verdicts as stored in emails.auth_status (see core parseAuthenticationHeaders). */
export interface AuthStatus {
  spf: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'unknown';
  dkim: 'pass' | 'fail' | 'none' | 'unknown';
  dmarc: 'pass' | 'fail' | 'none' | 'unknown';
  overall: 'pass' | 'partial' | 'fail' | 'none';
}

/**
 * From safest to most dangerous. Ordered so callers can compare with `>`
 * via {@link LEVEL_RANK} — "escalate the thread banner to the worst message".
 */
export type SecurityLevel = 'verified' | 'authenticated' | 'unverified' | 'caution' | 'danger';

export const LEVEL_RANK: Record<SecurityLevel, number> = {
  verified: 0,
  authenticated: 1,
  unverified: 2,
  caution: 3,
  danger: 4,
};

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'unknown';

/** One line of the tooltip: what was checked and how it came out. */
export interface SecurityCheck {
  id: 'spf' | 'dkim' | 'dmarc' | 'sender' | 'links' | 'spam' | 'brand';
  label: string;
  status: CheckStatus;
  /** Plain-language detail, e.g. "Text says x.com, link goes to y.com". */
  detail: string;
}

export interface LinkRuleSets {
  /** Keys from {@link linkRuleKey} the user has chosen to trust. */
  trusted: ReadonlySet<string>;
  /** Keys from {@link linkRuleKey} the user has chosen to block. */
  blocked: ReadonlySet<string>;
}

/** The domain's BIMI standing as the main process cached it (see sender-identity). */
export interface BimiIdentity {
  status: 'verified' | 'logo' | 'declined' | 'none' | 'invalid' | 'error';
  organization?: string | null;
  issuer?: string | null;
  detail?: string | null;
}

export interface SecurityAssessment {
  level: SecurityLevel;
  checks: SecurityCheck[];
  /** Deceptive links found and NOT covered by a trust rule — what "I trust" acts on. */
  untrustedLinks: LinkMismatch[];
  /** Deceptive links the user has explicitly blocked — forces `danger`. */
  blockedLinks: LinkMismatch[];
  /** Registrable domain of the sender, or null when the address is unusable. */
  senderDomain: string | null;
  /** The spam filter's stored verdict; `verdict` is null when the row was never scored. */
  spam: { verdict: SpamVerdict | null; score: number | null; reasons: SpamReason[] };
}

/**
 * The identity of a trust/block rule. Scoped to the SENDER domain on purpose:
 * trusting "x.com → y.com" for everyone would let any sender use that
 * redirect unflagged, and a compromised known account is the usual way
 * phishing arrives from a familiar name.
 */
export function linkRuleKey(senderDomain: string, shown: string, actual: string): string {
  return `${senderDomain}|${shown}|${actual}`.toLowerCase();
}

export const EMPTY_RULES: LinkRuleSets = { trusted: new Set(), blocked: new Set() };

/** Parse the stored JSON; anything unreadable is "no verdict", never a throw. */
export function parseAuthStatus(raw: string | null | undefined): AuthStatus | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AuthStatus>;
    if (!v || typeof v !== 'object') return null;
    return {
      spf: v.spf ?? 'unknown',
      dkim: v.dkim ?? 'unknown',
      dmarc: v.dmarc ?? 'unknown',
      overall: v.overall ?? 'none',
    };
  } catch {
    return null;
  }
}

const authCheck = (
  id: 'spf' | 'dkim' | 'dmarc',
  label: string,
  value: string | undefined,
  passText: string,
  failText: string,
): SecurityCheck => {
  if (value === 'pass') return { id, label, status: 'pass', detail: passText };
  if (value === 'fail') return { id, label, status: 'fail', detail: failText };
  if (value === 'softfail' || value === 'neutral') {
    return { id, label, status: 'warn', detail: `${label} returned ${value} — the sender's policy did not vouch for this server` };
  }
  return { id, label, status: 'unknown', detail: `The receiving server recorded no ${label} verdict` };
};

/**
 * Decide the level for one message.
 *
 * @param input.authStatus the stored emails.auth_status JSON, if any
 * @param input.spamScore the stored emails.spam_score, if the row was scored
 * @param input.spamReasons the stored emails.spam_reasons JSON, if any
 * @param input.bimi the domain's BIMI standing when the caller has looked it
 *   up: null = not known yet, an object = the cached standing. Omit it entirely
 *   when brand identity is not part of this view, and no check line appears.
 * @param input.rules the user's trust/block rules (defaults to none)
 */
export function assessEmailSecurity(input: {
  fromName?: string | null;
  fromAddress?: string | null;
  html?: string | null;
  authStatus?: string | null;
  spamScore?: number | null;
  spamReasons?: string | null;
  bimi?: BimiIdentity | null;
  rules?: LinkRuleSets;
}): SecurityAssessment {
  const rules = input.rules ?? EMPTY_RULES;
  const senderDomain = registrableDomain(input.fromAddress?.split('@')[1] ?? null);
  const auth = parseAuthStatus(input.authStatus);

  const dkimCheck = authCheck('dkim', 'DKIM', auth?.dkim,
    'The message signature is valid — it was not altered in transit',
    'The message signature is INVALID — it was altered or forged');
  if (auth?.dkim === 'fail' && auth?.dmarc === 'pass') {
    // A broken DKIM signature under a PASSING DMARC is routine: a mailing list
    // or forwarder re-wrote the message and invalidated one signature, while
    // SPF (or another signature) still aligned with the From domain. Reporting
    // it as a failure put a red shield on a bank statement — a false alarm
    // that teaches the reader to ignore red. Keep it visible, as a warning.
    dkimCheck.status = 'warn';
    dkimCheck.detail = 'A signature was broken in transit, but DMARC still passed — the sender’s domain is confirmed';
  }
  const checks: SecurityCheck[] = [
    authCheck('spf', 'SPF', auth?.spf,
      'The sending server is authorised for this domain',
      'The sending server is NOT authorised for this domain'),
    dkimCheck,
    authCheck('dmarc', 'DMARC', auth?.dmarc,
      'The domain owner’s policy accepts this message',
      'The domain owner’s policy REJECTS this message'),
  ];

  // Display-name impersonation.
  const spoof = assessSender(input.fromName, input.fromAddress);
  checks.push(spoof.length
    ? { id: 'sender', label: 'Sender name', status: 'fail', detail: spoof[0].text }
    : { id: 'sender', label: 'Sender name', status: 'pass', detail: 'The display name does not impersonate another domain' });

  // Deceptive links, minus the pairs the user has vetted.
  const all = linkMismatches(input.html);
  const key = (m: LinkMismatch) => linkRuleKey(senderDomain ?? '', m.shown, m.actual);
  const blockedLinks = all.filter((m) => rules.blocked.has(key(m)));
  const untrustedLinks = all.filter((m) => !rules.trusted.has(key(m)) && !rules.blocked.has(key(m)));
  const trustedCount = all.length - blockedLinks.length - untrustedLinks.length;

  if (blockedLinks.length) {
    checks.push({ id: 'links', label: 'Links', status: 'fail',
      detail: `A link you have blocked: text says ${blockedLinks[0].shown}, goes to ${blockedLinks[0].actual}` });
  } else if (untrustedLinks.length) {
    checks.push({ id: 'links', label: 'Links', status: 'warn',
      detail: `Text says ${untrustedLinks[0].shown}, link goes to ${untrustedLinks[0].actual}`
        + (untrustedLinks.length > 1 ? ` (+${untrustedLinks.length - 1} more)` : '') });
  } else {
    checks.push({ id: 'links', label: 'Links', status: 'pass',
      detail: trustedCount
        ? `Link domains match what they show (${trustedCount} pair${trustedCount > 1 ? 's' : ''} you trust)`
        : 'Link domains match what they show' });
  }

  // The spam filter's verdict, as stored when the message arrived. Shown with
  // its reasons so "filed as spam" is never a bare adjective either.
  const spamScore = typeof input.spamScore === 'number' && Number.isFinite(input.spamScore) ? input.spamScore : null;
  const verdict = spamVerdict(spamScore);
  const spamReasons = parseSpamReasons(input.spamReasons);
  const spam = { verdict, score: spamScore, reasons: spamReasons };
  const spamSummary = spamReasons.map((r) => r.detail).join('; ');
  if (verdict === 'spam') {
    checks.push({ id: 'spam', label: 'Spam filter', status: 'fail', detail: `Scored ${spamScore} — ${spamSummary}` });
  } else if (verdict === 'suspicious') {
    checks.push({ id: 'spam', label: 'Spam filter', status: 'warn', detail: `Scored ${spamScore} — ${spamSummary}` });
  } else if (verdict === 'clean') {
    checks.push({ id: 'spam', label: 'Spam filter', status: 'pass',
      detail: spamReasons.length ? `Scored ${spamScore} — ${spamSummary}` : 'No spam signals in the headers' });
  } else {
    checks.push({ id: 'spam', label: 'Spam filter', status: 'unknown',
      detail: 'Not scored — synced before the spam filter existed, or your own outgoing mail' });
  }

  // Brand identity (BIMI). The logo and the tick are shown only on a DMARC
  // pass — the certificate says who owns the brand, DMARC says this message
  // came from them. Reported here so the shield explains a tick's absence.
  if (input.bimi !== undefined) {
    const b = input.bimi;
    const dmarcPass = auth?.dmarc === 'pass';
    const brand = (status: CheckStatus, detail: string): SecurityCheck => ({ id: 'brand', label: 'Brand identity', status, detail });
    if (!b) checks.push(brand('unknown', 'Not looked up yet'));
    else if (b.status === 'verified') {
      checks.push(dmarcPass
        ? brand('pass', `${b.organization ?? 'The brand'} proved ownership of ${senderDomain ?? 'this domain'} with a Verified Mark Certificate from ${b.issuer ?? 'a Mark Verifying Authority'}`)
        : brand('warn', 'The domain publishes a verified logo, but this message did not pass DMARC — logo and tick withheld'));
    } else if (b.status === 'logo') {
      checks.push(dmarcPass
        ? brand('pass', 'The domain publishes a BIMI logo, without a Verified Mark Certificate')
        : brand('warn', 'The domain publishes a logo, but this message did not pass DMARC — logo withheld'));
    } else if (b.status === 'declined') checks.push(brand('unknown', 'The domain declines to show a logo'));
    else if (b.status === 'none') checks.push(brand('unknown', 'The domain publishes no BIMI record'));
    else if (b.status === 'invalid') checks.push(brand('unknown', `BIMI record unusable: ${b.detail ?? 'see Security → Sender identity'}`));
    else checks.push(brand('unknown', 'Brand lookup failed; it will be retried'));
  }

  // ---- the level ---------------------------------------------------------
  // Hard failures first: an authoritative FAIL, an impersonating display
  // name, or a link the user explicitly blocked. Nothing below can soften these.
  //
  // "Authoritative" means DMARC. It is the check that asks whether the domain
  // in From: is the domain that actually authenticated — the question a reader
  // cares about. SPF and DKIM are its inputs: either one can fail for benign
  // reasons (a forwarder, a list, a second signature) while DMARC still
  // passes, and core's `overall` — which fails on ANY component — turned those
  // into red shields on Axis Bank, IHG and CII mail. Only when the server
  // recorded no DMARC verdict at all do we fall back to "both inputs failed".
  const dmarcKnown = auth?.dmarc === 'pass' || auth?.dmarc === 'fail';
  const authFailed = auth?.dmarc === 'fail'
    || (!dmarcKnown && auth?.spf === 'fail' && auth?.dkim === 'fail');
  if (authFailed || spoof.length > 0 || blockedLinks.length > 0) {
    return { level: 'danger', checks, untrustedLinks, blockedLinks, senderDomain, spam };
  }
  // Soft signals: an unvetted deceptive link, a policy that declined to vouch,
  // a single failed input with no DMARC verdict to settle the question — or
  // the spam filter having filed it. Spam is caution, not danger: the reasons
  // that make spam DANGEROUS (a failed DMARC, a spoofed name) already score
  // danger on their own above; the rest is unwanted, not impersonation.
  const softAuth = auth?.spf === 'softfail' || auth?.spf === 'neutral'
    || (!dmarcKnown && (auth?.spf === 'fail' || auth?.dkim === 'fail'));
  if (untrustedLinks.length > 0 || softAuth || verdict === 'spam') {
    return { level: 'caution', checks, untrustedLinks, blockedLinks, senderDomain, spam };
  }
  // Clean. Now: how STRONGLY do we know who sent it? DMARC pass settles it;
  // without a DMARC verdict, SPF and DKIM both passing is the next best thing.
  const authPassed = auth?.dmarc === 'pass' || (!dmarcKnown && auth?.spf === 'pass' && auth?.dkim === 'pass');
  if (authPassed) {
    // Fully authenticated AND every link stays on the sender's own domain (or
    // is a pair the user vetted): the top level. A newsletter that passes
    // DMARC but links out to its CDN and tracker is authenticated, not
    // verified — real, but not "everything in this mail is the sender".
    const linksStayHome = linkDomainsAllMatch(input.html, senderDomain);
    return {
      level: linksStayHome ? 'verified' : 'authenticated',
      checks, untrustedLinks, blockedLinks, senderDomain, spam,
    };
  }
  return { level: 'unverified', checks, untrustedLinks, blockedLinks, senderDomain, spam };
}

/**
 * True when every http(s) link in the body resolves to the sender's own
 * registrable domain. Absence of links counts as true — nothing points away.
 */
function linkDomainsAllMatch(html: string | null | undefined, senderDomain: string | null): boolean {
  if (!html || !senderDomain || typeof DOMParser === 'undefined') return !html;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return false;
  }
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(href)) continue;
    let d: string | null = null;
    try { d = registrableDomain(new URL(href).hostname); } catch { return false; }
    if (d && d !== senderDomain) return false;
  }
  return true;
}

/** The worst level among several messages — what a thread-level banner shows. */
export function worstLevel(levels: SecurityLevel[]): SecurityLevel {
  return levels.reduce<SecurityLevel>(
    (worst, l) => (LEVEL_RANK[l] > LEVEL_RANK[worst] ? l : worst),
    'verified',
  );
}

/** Human copy for each level, shared by the tooltip and the Security page. */
export const LEVEL_COPY: Record<SecurityLevel, { title: string; summary: string }> = {
  verified: {
    title: 'Verified',
    summary: 'Passed SPF, DKIM and DMARC, and every link stays on the sender’s own domain.',
  },
  authenticated: {
    title: 'Authenticated',
    summary: 'The sending domain is confirmed by SPF, DKIM and DMARC. Links point elsewhere, which is normal for newsletters.',
  },
  unverified: {
    title: 'Unverified',
    summary: 'No authentication verdict was recorded, so the sender cannot be confirmed — common for small senders, not itself suspicious.',
  },
  caution: {
    title: 'Caution',
    summary: 'Something does not add up: a link goes somewhere other than it says, or the sender’s policy did not vouch for this server.',
  },
  danger: {
    title: 'Dangerous',
    summary: 'Authentication failed, the display name impersonates another domain, or a link you blocked is present.',
  },
};

/**
 * Which message in a thread should carry the ONE warning banner.
 *
 * Per-message banners repeated down a long thread; a banner pinned to the
 * first message mislabels a clean opener when message 14 is the spoof. The
 * ThreadList comment records that second failure as a real bug that had to be
 * fixed. So: one banner, on the FIRST message (by date) whose level is caution
 * or worse. Null when nothing in the thread warrants one.
 */
export function firstFlaggedEmailId(
  emails: Array<{
    id: string;
    date: number;
    fromName?: string | null;
    fromAddress?: string | null;
    rawBody?: string | null;
    authStatus?: string | null;
    spamScore?: number | null;
    spamReasons?: string | null;
  }>,
  rules: LinkRuleSets = EMPTY_RULES,
): string | null {
  const sorted = [...emails].sort((a, b) => a.date - b.date);
  for (const e of sorted) {
    const { level } = assessEmailSecurity({
      fromName: e.fromName, fromAddress: e.fromAddress, html: e.rawBody, authStatus: e.authStatus,
      spamScore: e.spamScore, spamReasons: e.spamReasons, rules,
    });
    if (LEVEL_RANK[level] >= LEVEL_RANK.caution) return e.id;
  }
  return null;
}
