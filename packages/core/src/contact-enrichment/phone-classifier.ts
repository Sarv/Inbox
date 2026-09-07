// Deterministic, cross-domain phone classification.
//
// The insight (no LLM): within one organization domain, the phone number that
// shows up in MANY members' signatures is the shared office/switchboard line,
// while a number that appears for exactly one member (and recurs across their
// own mail) is that person's own direct/mobile number. We mine phones from each
// sender's signature, group by domain, and split them on that frequency signal.

import { normalizePhoneToE164 } from './phone-normalizer';
import { splitByAuthor } from './quote-attribution';
import { extractSignals } from './signal-extractor';

/** Free/public mail providers — each user is independent, so no "org number" logic. */
export const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'icloud.com', 'me.com', 'aol.com',
  'proton.me', 'protonmail.com', 'rediffmail.com', 'zoho.com', 'gmx.com', 'mail.com',
]);

export interface SenderPhones {
  email: string;
  domain: string;
  /** normalized key -> { display, count } (count = # of the sender's emails it appeared in). */
  phones: Map<string, { display: string; count: number }>;
  /**
   * Optional per-number confidence from the weighted scorer (see
   * phone-scoring.ts). When present it breaks ties that raw frequency cannot:
   * a number labelled "Mobile:" inside a signature outranks one that merely
   * appeared more often in prose. Absent = fall back to count ordering, so
   * existing callers behave exactly as before.
   */
  scores?: Record<string, number>;
}

export interface ClassifiedPhones {
  /** Shared org/switchboard number (display form), or null. */
  officePhone: string | null;
  /** The sender's own direct/mobile number (display form), or null. */
  directPhone: string | null;
}

/** Domain of an address, lowercased. */
export function domainOf(email: string): string {
  const at = (email || '').lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).toLowerCase().trim() : '';
}

/**
 * Fold one email's extracted phone display-strings into the running per-sender
 * tally. Each number is counted at most once per email (a number quoted twice
 * in one signature isn't "more recurring"). Shared by minePhones and the
 * single-pass mineContactSignals so the counting rules live in one place.
 */
function accumulatePhones(out: SenderPhones['phones'], phones: string[]): void {
  const seenThisEmail = new Set<string>(); // count each number once per email
  for (const display of phones) {
    const key = normalizePhoneToE164(display) || display.replace(/\D/g, '');
    if (!key || key.length < 8 || seenThisEmail.has(key)) continue;
    seenThisEmail.add(key);
    const cur = out.get(key) || { display, count: 0 };
    cur.count += 1;
    out.set(key, cur);
  }
}

/**
 * Mine phones from one sender's email bodies. Returns a normalized-key ->
 * {display, count} map, where count is how many of the sender's emails the
 * number appeared in (a stable, recurring number scores higher than a one-off).
 */
export function minePhones(bodies: string[], fromAddress: string): SenderPhones['phones'] {
  const out: SenderPhones['phones'] = new Map();
  for (const body of bodies) {
    if (!body) continue;
    let phones: string[] = [];
    try { phones = extractSignals(body, fromAddress).phones; } catch { phones = []; }
    accumulatePhones(out, phones);
  }
  return out;
}

export interface MinedLinkedIn {
  /** linkedin.com/in/… — the contact's own profile. */
  personal: string | null;
  /** linkedin.com/company/… — their organization's page. */
  company: string | null;
}

/**
 * Classify + clean a LinkedIn URL. `/in/` (and legacy `/pub/`) is a PERSONAL
 * profile; `/company/` (and `/school/`) is an ORGANIZATION page. Anything else
 * (feed links, share buttons, a bare linkedin.com) isn't a profile → null.
 * Query string / fragment / trailing slash are dropped so the same profile
 * dedups across signatures.
 */
function classifyLinkedIn(raw: string): { type: 'personal' | 'company'; url: string } | null {
  const trimmed = (raw || '').trim();
  if (!/linkedin\.com/i.test(trimmed)) return null;
  const url = trimmed.split(/[?#]/)[0].replace(/\/+$/, '');
  const path = url.toLowerCase();
  if (/linkedin\.com\/(?:company|school)\/[^/]/.test(path)) return { type: 'company', url };
  if (/linkedin\.com\/(?:in|pub)\/[^/]/.test(path)) return { type: 'personal', url };
  return null;
}

/**
 * Fold one email's extracted LinkedIn URLs into the running personal/company
 * tallies (each unique cleaned URL counted once per email). Shared by
 * mineLinkedIn and the single-pass mineContactSignals.
 */
function accumulateLinkedIn(
  personal: Map<string, number>,
  company: Map<string, number>,
  urls: string[],
): void {
  const seenThisEmail = new Set<string>();
  for (const raw of urls) {
    const c = classifyLinkedIn(raw);
    if (!c || seenThisEmail.has(c.url)) continue;
    seenThisEmail.add(c.url);
    const map = c.type === 'company' ? company : personal;
    map.set(c.url, (map.get(c.url) || 0) + 1);
  }
}

/** The most-recurring URL in a URL->count map (or null when empty). */
function topByCount(m: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [url, count] of m) if (count > bestCount) { bestCount = count; best = url; }
  return best;
}

/**
 * Mine a contact's LinkedIn URLs from their email bodies (signatures). Returns
 * the most-recurring personal profile (/in/) and company page (/company/). No
 * cross-domain logic is needed here — unlike a shared office phone, a LinkedIn
 * URL in someone's own signature is unambiguously theirs.
 */
export function mineLinkedIn(bodies: string[], fromAddress: string): MinedLinkedIn {
  const personal = new Map<string, number>();
  const company = new Map<string, number>();
  for (const body of bodies) {
    if (!body) continue;
    let urls: string[] = [];
    try { urls = extractSignals(body, fromAddress).linkedinUrls; } catch { urls = []; }
    accumulateLinkedIn(personal, company, urls);
  }
  return { personal: topByCount(personal), company: topByCount(company) };
}

/** Count each unique URL once per email into the running tally. Mirrors
 *  accumulatePhones — a URL repeated within one signature isn't "more recurring".
 *  URLs are normalized (trailing slash + query/hash dropped) so trivially-
 *  different forms of the same link collapse to one key. */
function accumulateUrls(out: Map<string, number>, urls: string[]): void {
  const seenThisEmail = new Set<string>();
  for (const raw of urls) {
    const url = (raw || '').trim().split(/[?#]/)[0].replace(/\/+$/, '');
    if (!url || seenThisEmail.has(url)) continue;
    seenThisEmail.add(url);
    out.set(url, (out.get(url) || 0) + 1);
  }
}

/** Phones + LinkedIn for one sender, mined in a single pass over their bodies. */
export interface MinedContactSignals {
  phones: SenderPhones['phones'];
  /** Best weighted score seen per number — feeds SenderPhones.scores. */
  scores: Record<string, number>;
  linkedin: MinedLinkedIn;
  // Raw per-URL tallies (url -> # of the sender's emails it appeared in), by
  // type. Fed to classifyDomainUrls to split ORG (a value shared across many of
  // a domain's senders — the company Twitter/site) from PERSONAL (unique to one
  // sender). LinkedIn is NOT here: it self-distinguishes via /in/ vs /company/.
  twitter: Map<string, number>;
  websites: Map<string, number>;
  socials: Map<string, number>; // facebook / instagram / youtube / …
}

/**
 * Mine BOTH phones and LinkedIn URLs from a sender's bodies in ONE pass.
 * extractSignals() already returns .phones and .linkedinUrls from a single
 * parse, so this calls it once per body and feeds both classifications from the
 * same result — instead of minePhones + mineLinkedIn each re-parsing every body.
 * Output is byte-for-byte identical to calling the two functions separately;
 * prefer this whenever a caller needs both signals for the same bodies.
 */
export function mineContactSignals(bodies: string[], fromAddress: string): MinedContactSignals {
  const phones: SenderPhones['phones'] = new Map();
  const scores: Record<string, number> = {};
  const personal = new Map<string, number>();
  const company = new Map<string, number>();
  const twitter = new Map<string, number>();
  const websites = new Map<string, number>();
  const socials = new Map<string, number>();
  for (const body of bodies) {
    if (!body) continue;
    let s: ReturnType<typeof extractSignals> | null = null;
    try { s = extractSignals(body, fromAddress); } catch { s = null; }
    if (!s) continue;
    accumulatePhones(phones, s.phones);
    accumulateLinkedIn(personal, company, s.linkedinUrls);
    accumulateUrls(twitter, s.twitterUrls);
    accumulateUrls(websites, s.websites);
    accumulateUrls(socials, s.otherSocials);
    for (const [k, v] of Object.entries(s.phoneScores || {})) {
      if (scores[k] === undefined || v > scores[k]) scores[k] = v;
    }
  }
  return {
    phones, scores,
    linkedin: { personal: topByCount(personal), company: topByCount(company) },
    twitter, websites, socials,
  };
}

// ===== Domain URL classification (org vs personal) ==========================
// Same insight as the phone switchboard split, applied to Twitter/website/other
// socials: a URL that recurs across MANY of a domain's senders is the company's
// (org); one that appears for a single sender is theirs (personal). Simpler than
// phones — no country-code / veto scoring — just distinct-sender frequency.

export interface SenderUrls {
  email: string;
  domain: string;
  twitter: Map<string, number>;
  websites: Map<string, number>;
  socials: Map<string, number>;
}

/** The personal (sender-unique) URLs for one contact. */
export interface ClassifiedUrls {
  twitter: string | null;
  website: string | null;
  socials: string[];
}

/** The org (domain-shared) URLs for one company. */
export interface DomainOrgUrls {
  twitter: string | null;
  website: string | null;
  socials: string[];
}

/** Distinct-sender count per URL within a domain: url -> set of sender emails. */
function tallyBySender(members: SenderUrls[], pick: (m: SenderUrls) => Map<string, number>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of members) {
    for (const url of pick(m).keys()) {
      (out.get(url) ?? out.set(url, new Set()).get(url)!).add(m.email);
    }
  }
  return out;
}

/**
 * Split each sender's mined URLs into ORG (shared across ≥2 of the domain's
 * senders) vs PERSONAL (carried by exactly one). Public mail domains (gmail.com…)
 * have no "org", so every URL there is personal. Returns per-email personal URLs
 * AND per-domain org URLs (the latter to store once on the company record).
 */
export function classifyDomainUrls(senders: SenderUrls[]): {
  perEmail: Map<string, ClassifiedUrls>;
  perDomain: Map<string, DomainOrgUrls>;
} {
  const perEmail = new Map<string, ClassifiedUrls>();
  const perDomain = new Map<string, DomainOrgUrls>();
  const byDomain = new Map<string, SenderUrls[]>();

  for (const s of senders) {
    if (!s.domain || PUBLIC_DOMAINS.has(s.domain)) {
      // No org concept — everything the sender carries is personal.
      perEmail.set(s.email, {
        twitter: topByCount(s.twitter),
        website: topByCount(s.websites),
        socials: [...s.socials.keys()],
      });
      continue;
    }
    (byDomain.get(s.domain) ?? byDomain.set(s.domain, []).get(s.domain)!).push(s);
  }

  for (const [domain, members] of byDomain) {
    const twStats = tallyBySender(members, (m) => m.twitter);
    const webStats = tallyBySender(members, (m) => m.websites);
    const socStats = tallyBySender(members, (m) => m.socials);
    const isOrg = (stats: Map<string, Set<string>>, url: string) => (stats.get(url)?.size ?? 0) >= 2;

    // Org = the shared value (most distinct senders wins for the single-valued
    // twitter/website; all shared ones for socials).
    const topShared = (stats: Map<string, Set<string>>): string | null => {
      let best: string | null = null, bestN = 1;
      for (const [url, set] of stats) if (set.size >= 2 && set.size > bestN) { bestN = set.size; best = url; }
      return best;
    };
    perDomain.set(domain, {
      twitter: topShared(twStats),
      website: topShared(webStats),
      socials: [...socStats].filter(([, set]) => set.size >= 2).map(([url]) => url),
    });

    for (const m of members) {
      // Personal = a URL this sender carries that is NOT domain-shared.
      const firstPersonal = (own: Map<string, number>, stats: Map<string, Set<string>>): string | null => {
        for (const url of own.keys()) if (!isOrg(stats, url)) return url;
        return null;
      };
      perEmail.set(m.email, {
        twitter: firstPersonal(m.twitter, twStats),
        website: firstPersonal(m.websites, webStats),
        socials: [...m.socials.keys()].filter((url) => !isOrg(socStats, url)),
      });
    }
  }

  return { perEmail, perDomain };
}

/**
 * Mine phones from a sender's bodies AND credit quoted blocks to whoever
 * actually wrote them.
 *
 * Returns a map of author-address -> phone counts. The sender's own writing is
 * keyed under `fromAddress`; a quoted reply chain contributes to the address
 * named in its quote header instead. Segments whose author can't be determined
 * are dropped rather than guessed — an unattributable number is exactly the
 * kind that ends up on the wrong contact.
 *
 * This is what makes ownership reliable: the person who is quoted a lot now
 * ACCUMULATES evidence for their own number instead of losing it to the people
 * quoting them.
 */
export function mineAttributedPhones(
  bodies: string[],
  fromAddress: string,
): Map<string, SenderPhones['phones']> {
  const byAuthor = new Map<string, SenderPhones['phones']>();
  const self = (fromAddress || '').toLowerCase().trim();

  for (const body of bodies) {
    if (!body) continue;
    let segments;
    try {
      segments = splitByAuthor(body, fromAddress);
    } catch {
      continue;
    }
    for (const seg of segments) {
      if (!seg.author) continue; // unattributable — never guess
      let phones: string[] = [];
      try {
        // Extract as if this segment were that author's own mail. Their
        // signature is the trailing block, which is precisely what we want.
        phones = extractSignals(seg.text, seg.author).phones;
      } catch {
        phones = [];
      }
      if (phones.length === 0) continue;
      const key = seg.author === self ? self : seg.author;
      let bucket = byAuthor.get(key);
      if (!bucket) { bucket = new Map(); byAuthor.set(key, bucket); }
      accumulatePhones(bucket, phones);
    }
  }
  return byAuthor;
}

/**
 * Classify every sender's phones into office (shared across the domain) vs
 * direct (unique to the sender). Returns a map keyed by sender email.
 *
 * Rules:
 *  - Public domains (gmail/outlook/…): no shared-org logic — the sender's most
 *    recurring number is treated as their direct number.
 *  - Org domains with >= 3 members: a number present in a LARGE FRACTION of
 *    members (>= 25%, min 3 distinct senders) and not dominated by a single
 *    owner (max/total < 0.5) is an office/shared line; the rest are personal.
 *    Distinct-sender FRACTION is the separator — a switchboard reaches many
 *    signatures, while even a heavily-quoted personal number reaches far fewer.
 *    A sender's office = the most-widely-shared org number they carry; their
 *    direct = the most-recurring non-shared number they actually OWN (their
 *    count is the max for that key, so a merely-quoted number isn't claimed).
 *  - Small org domains (< 3 members): can't judge sharing, so the most-recurring
 *    number is the direct number and any second number is tentatively office.
 */
export function classifyDomainPhones(senders: SenderPhones[]): Map<string, ClassifiedPhones> {
  const result = new Map<string, ClassifiedPhones>();
  const byDomain = new Map<string, SenderPhones[]>();

  for (const s of senders) {
    if (!s.domain || PUBLIC_DOMAINS.has(s.domain)) {
      result.set(s.email, { officePhone: null, directPhone: mostRecurring(s.phones) });
      continue;
    }
    const list = byDomain.get(s.domain);
    if (list) list.push(s); else byDomain.set(s.domain, [s]);
  }

  for (const members of byDomain.values()) {
    const memberCount = members.length;
    // Per phone key across the domain: how many DISTINCT senders carry it, the
    // TOTAL occurrences, and the MAX any single sender contributes.
    const stats = new Map<string, { senders: number; total: number; max: number }>();
    const ccSenders = new Map<string, Set<string>>(); // country code -> distinct senders
    for (const m of members) {
      for (const [key, { count }] of m.phones) {
        const st = stats.get(key) || { senders: 0, total: 0, max: 0 };
        st.senders += 1;
        st.total += count;
        st.max = Math.max(st.max, count);
        stats.set(key, st);
        const cc = countryCode(key);
        if (cc) (ccSenders.get(cc) || ccSenders.set(cc, new Set()).get(cc)!).add(m.email);
      }
    }
    // Dominant country code of the domain (by distinct senders). A number whose
    // country code differs is almost always foreign CONTENT the sender merely
    // typed — e.g. a recruiter's mail is full of candidates' +1 numbers while
    // the whole org is +91. Only enforced when the dominant CC is well-attested
    // (>= 2 senders) so we don't over-filter a tiny/mixed domain.
    let dominantCC = '';
    let dominantN = 0;
    for (const [cc, set] of ccSenders) if (set.size > dominantN) { dominantN = set.size; dominantCC = cc; }
    const ccOk = (key: string): boolean => {
      if (dominantN < 2 || !dominantCC) return true;
      const cc = countryCode(key);
      return !cc || cc === dominantCC;
    };
    // Office/shared line = present in a LARGE FRACTION of the domain's members
    // (>= 25%, min 3 senders) AND not dominated by a single owner's total.
    // Distinct-sender FRACTION is the reliable separator: a real switchboard
    // shows up in many people's signatures (~36% here), while even a heavily
    // quoted personal number reaches far fewer distinct senders (~12%). The
    // owner still writes their own number far more, so max/total < 0.5 also
    // guards against a single high-volume sender's number looking shared.
    const orgKeys = new Set<string>();
    if (memberCount >= 3) {
      const orgThreshold = Math.max(3, Math.ceil(memberCount * 0.25));
      for (const [key, st] of stats) {
        if (st.senders >= orgThreshold && st.max / st.total < 0.5 && ccOk(key)) orgKeys.add(key);
      }
    }

    for (const m of members) {
      const keys = [...m.phones.keys()].filter(ccOk);
      const office = keys
        .filter((k) => orgKeys.has(k))
        .sort((a, b) => (stats.get(b)?.senders || 0) - (stats.get(a)?.senders || 0))[0] || null;
      // M1 fix: in a small domain (< 3 members) the org-fraction test above is
      // skipped, so a landline shared by two colleagues has no orgKey to keep it
      // out of `direct` — it would become each person's directPhone → same
      // mobile_e164 → both merged under one person_id. A number carried by MORE
      // THAN ONE member's signatures is shared (office-grade), never identity-
      // grade: require a per-sender-unique number (senders === 1) for `direct`.
      const sharedInSmallDomain = (k: string): boolean =>
        memberCount < 3 && (stats.get(k)?.senders || 0) > 1;
      // A direct number must be one this sender actually OWNS — their own count
      // is the highest anyone contributes for that key. This drops a number the
      // sender merely QUOTED from someone else (owner's count dominates).
      // Rank by confidence first, count second. A vetoed number (fax, toll-free,
      // conference dial-in) scores -Infinity and is dropped outright.
      const scoreOf = (k: string): number => m.scores?.[k] ?? 0;
      const rank = (a: string, b: string): number =>
        (scoreOf(b) - scoreOf(a)) || ((m.phones.get(b)?.count || 0) - (m.phones.get(a)?.count || 0));
      const notVetoed = (k: string): boolean => scoreOf(k) !== Number.NEGATIVE_INFINITY;

      const personal = keys
        .filter((k) => notVetoed(k) && !orgKeys.has(k) && !sharedInSmallDomain(k)
          && (m.phones.get(k)?.count || 0) >= (stats.get(k)?.max || 0))
        .sort(rank);
      let direct = personal[0] || null;
      let officeKey = office;
      // Small domain: no reliable sharing signal → a genuinely shared line (in
      // >1 member's sigs) is the office number; else the 2nd-most-recurring one.
      if (memberCount < 3 && !officeKey) {
        const shared = keys
          .filter((k) => (stats.get(k)?.senders || 0) > 1)
          .sort((a, b) => (stats.get(b)?.senders || 0) - (stats.get(a)?.senders || 0));
        officeKey = shared[0] || (personal.length >= 2 ? personal[1] : null);
      }
      if (officeKey === direct) direct = personal.find((k) => k !== officeKey) || null;

      // LAST RESORT: we found numbers for this sender but attributed none of
      // them as their own. The ownership test above (`count >= stats.max`) is
      // there to reject a number the sender merely QUOTED from someone else —
      // but it also rejects a sender's real mobile whenever a colleague quoted
      // their signature more often than they sent it themselves. With only a
      // handful of their own mails in the store, that is the common case, not
      // the edge case: the contact then shows the switchboard labelled
      // "(office)" and no direct number at all.
      //
      // So if nothing survived, take the sender's most-recurring number that
      // isn't the office line. It is still not attributed to anyone else as
      // *their* direct number (orgKeys/office are excluded), so the worst case
      // is a quoted number shown as direct — strictly better than showing the
      // switchboard as if it were the person's own.
      // Excluding every orgKey here would defeat the purpose: once a few
      // colleagues quote a signature, that person's own mobile crosses the
      // org threshold and looks shared. Use SHARE to tell the two apart — a
      // real switchboard reaches most of the domain, a quoted mobile reaches a
      // small minority. Anything carried by half the members or more stays
      // barred from being read as one person's direct line.
      if (!direct) {
        const minorityShare = (k: string): boolean =>
          !orgKeys.has(k) || (stats.get(k)?.senders || 0) / memberCount < 0.5;
        // OWNERSHIP IS NOT NEGOTIABLE, even here. Dropping it would let this
        // sender claim a number that someone else demonstrably owns — a
        // colleague's personal mobile, quoted into this sender's mail, shown on
        // their contact card as if it were theirs. That is a worse failure than
        // showing no number: it is confidently wrong, and it merges two people
        // under one identity downstream (mobile_e164 drives person_id).
        // So the fallback only relaxes the ORG classification, never ownership.
        const ownsIt = (k: string): boolean =>
          (m.phones.get(k)?.count || 0) >= (stats.get(k)?.max || 0);
        direct = keys
          .filter((k) => k !== officeKey && notVetoed(k) && minorityShare(k) && ownsIt(k))
          .sort(rank)[0] || null;
      }
      result.set(m.email, {
        officePhone: officeKey ? m.phones.get(officeKey)!.display : null,
        directPhone: direct ? m.phones.get(direct)!.display : null,
      });
    }
  }
  return result;
}

/**
 * Best-effort country code from an E.164-ish key: the national number is
 * (almost always) the last 10 digits, so anything before it is the country
 * code. "+919111911100" -> "91", "+14155550165" -> "1". Empty when we can't
 * tell (<= 10 digits), so short/landline numbers aren't wrongly filtered.
 */
function countryCode(key: string): string {
  const d = (key || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(0, d.length - 10) : '';
}

/** The display form of the most-recurring phone in a map (or null). */
function mostRecurring(phones: SenderPhones['phones']): string | null {
  let best: { display: string; count: number } | null = null;
  for (const v of phones.values()) if (!best || v.count > best.count) best = v;
  return best ? best.display : null;
}
