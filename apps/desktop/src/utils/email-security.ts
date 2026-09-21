// The ONE place an email's security level is decided — and, now, the one place
// this app's WORDS for it live.
//
// The decision itself is `@sarv-in/email-spam-scan/security` now — the same
// rules the sync-time filter applies, so the level a tooltip shows, the level
// a banner escalates on and the level the Security page explains can never be
// three different answers, and none of them can drift from the verdict that
// actually filed the message. This module is the seam, and it keeps the
// things that belong to the product rather than to the library:
//
//   - the parameter name `authStatus`, which is the emails.auth_status column
//     every caller reads it out of;
//   - the human COPY for each level ({@link LEVEL_COPY}) — a library cannot
//     know the product's voice, its language or its reading age;
//   - the three check details that reference Inbox's own behaviour (mail that
//     predates the filter, the Sender identity page, the brand-lookup retry);
//   - {@link firstFlaggedEmailId}, the thread-level policy "one banner, on the
//     first message that warrants it", which belongs to this app's thread view.
//
// The entry it imports is renderer-safe: no MIME parser, no Node built-ins,
// unlike the core barrel, which pulls imapflow/mailparser into the browser
// bundle and blanks the renderer.

import {
  assessEmailSecurity as assessSecurity,
  EMPTY_RULES,
  LEVEL_RANK,
  type BrandIdentity,
  type LinkRuleSets,
  type SecurityAssessment,
  type SecurityCheck,
  type SecurityLevel,
} from '@sarv-in/email-spam-scan/security';

export { EMPTY_RULES, LEVEL_RANK, linkRuleKey, parseAuthStatus, worstLevel } from '@sarv-in/email-spam-scan/security';

export type {
  CheckStatus,
  LinkRuleSets,
  SecurityAssessment,
  SecurityCheck,
  SecurityLevel,
} from '@sarv-in/email-spam-scan/security';

/** Verdicts as stored in emails.auth_status (see core parseAuthenticationHeaders). */
export type { AuthStatus } from '@sarv-in/email-spam-scan/verdict';

/** The domain's BIMI standing as the main process cached it (see sender-identity). */
export type BimiIdentity = BrandIdentity;

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
 * @param input.bodyLoaded false while the body is still being fetched. Bodies
 *   load lazily here, so most callers know this and must say it: without it an
 *   unread message is assessed as one whose links were checked and found
 *   clean, which is the top level for a body nobody has read. The assessment
 *   comes back `pending` instead.
 */
export function assessEmailSecurity(input: {
  fromName?: string | null;
  fromAddress?: string | null;
  html?: string | null;
  bodyLoaded?: boolean;
  authStatus?: string | null;
  spamScore?: number | null;
  spamReasons?: string | null;
  bimi?: BimiIdentity | null;
  rules?: LinkRuleSets;
}): SecurityAssessment {
  const assessment = assessSecurity({
    fromName: input.fromName,
    fromAddress: input.fromAddress,
    html: input.html,
    bodyLoaded: input.bodyLoaded,
    auth: input.authStatus,
    spamScore: input.spamScore,
    spamReasons: input.spamReasons,
    rules: input.rules,
    ...('bimi' in input ? { bimi: input.bimi } : {}),
  });
  return { ...assessment, checks: assessment.checks.map((check) => inboxCopy(check, input.bimi)) };
}

/**
 * Three check lines say something only Inbox can say: why a message has no
 * score (it arrived before the filter existed, or we sent it), where to read
 * more about an unusable BIMI record, and that a failed brand lookup is
 * retried. The library states the same facts generically, because it has no
 * sync history and no Security page. Substituting the copy here keeps the
 * product's voice without a second copy of the logic that chose the status.
 */
function inboxCopy(check: SecurityCheck, bimi: BimiIdentity | null | undefined): SecurityCheck {
  const detail = (text: string): SecurityCheck => ({ ...check, detail: text });
  if (check.id === 'spam' && check.status === 'unknown') {
    return detail('Not scored — synced before the spam filter existed, or your own outgoing mail');
  }
  if (check.id === 'brand' && bimi) {
    if (bimi.status === 'invalid') {
      return detail(`BIMI record unusable: ${bimi.detail ?? 'see Security → Sender identity'}`);
    }
    if (bimi.status === 'error') return detail('Brand lookup failed; it will be retried');
  }
  return check;
}

/** Human copy for each level, shared by the tooltip and the Security page. */
export const LEVEL_COPY: Record<SecurityLevel, { title: string; summary: string }> = {
  verified: {
    title: 'Verified',
    // Deliberately not "every link stays on the sender’s own domain": most
    // personal mail contains no links at all, and saying so told a reader a
    // check had passed that never ran. The Links row below distinguishes the
    // two cases; this line only has to be true of both.
    summary: 'Passed SPF, DKIM and DMARC, and nothing in the message points away from the sender’s own domain.',
  },
  authenticated: {
    title: 'Authenticated',
    // "Some links", because one is enough to land here — and a reader looking
    // for the difference between this badge and the green one needs to know
    // it is about the links, not the authentication.
    summary: 'The sending domain is confirmed by SPF, DKIM and DMARC. Some links point elsewhere, which is normal for newsletters and shared documents.',
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
 * Copy for the state that is not a level: the body has not arrived, so the
 * link checks have not run and a clean-looking result would be provisional.
 *
 * It replaces only the reassuring levels. A `caution` or `danger` comes from
 * the headers, which arrive with the message, and showing a spinner over one
 * of those would withhold the warning at the only moment it matters.
 */
export const PENDING_COPY = {
  title: 'Still checking',
  summary: 'The message has not been downloaded yet, so its links are unchecked. Authentication below is final.',
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
