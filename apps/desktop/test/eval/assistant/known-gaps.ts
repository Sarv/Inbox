/**
 * Cases the Inbox Agent is KNOWN to get wrong today (assistant-eval.test.ts).
 *
 * This list is a debt register, not a set of expectations. Each entry is a
 * question from cases.ts that should work and does not, with what was observed
 * and the audit issue that covers it (.claude/audits/inbox-agent-2026-11-12,
 * "Issues in the order I would fix them"). The numbers in brackets are that
 * list's issue numbers.
 *
 * Two rules keep it honest:
 *   1. A listed case that starts passing FAILS the evaluation, with a message
 *      saying to delete its entry. That is how a fix becomes protected.
 *   2. A case that is not listed must pass. Adding an entry to get a change
 *      through is a decision to ship a regression: say so in the commit
 *      message, as for any other deliberately changed test.
 *
 * `floor` is the run with the planner refused (host keyword rules only);
 * `ceiling` is the run with the case's hand-written ideal plan, or for a
 * follow-up the question made self-contained. A gap listed under `ceiling`
 * cannot be fixed by a better model. Tasks run at the ceiling only.
 */
export interface KnownGap { floor?: string; ceiling?: string }

const ARRIVAL_DATE = 'nothing matches: "tomorrow" limits the search to mail that ARRIVES tomorrow, where no mail can exist [6]';
const BURIED = 'the email is found, but the sentence that answers is not in the excerpt that reaches the model [22]';
export const KNOWN_GAPS: Record<string, KnownGap> = {
  'meetings-tomorrow': { floor: ARRIVAL_DATE, ceiling: ARRIVAL_DATE },
  'lowercase-meetings-tomorrow': { floor: ARRIVAL_DATE },
  'hdfc-msa-penalty-cap': { floor: `${BURIED}: clause 31.3 of a long contract draft`, ceiling: `${BURIED}: clause 31.3 of a long contract draft` },
  'lowercase-hdfc-msa-penalty-cap': { floor: `${BURIED}: clause 31.3 of a long contract draft` },
  'ongc-bank-guarantee': { floor: `${BURIED}: point 46 of long minutes`, ceiling: `${BURIED}: point 46 of long minutes` },
  'lowercase-sbi-turnover-criterion': { floor: '24 emails are found, but the corrigendum sentence does not reach the model; the same question with capital letters works [11, 22]' },
  'hinglish-gurpreet-meeting': {
    floor: 'nothing matches: Hinglish words ("ne", "kab", "rakhi") become search terms, and "meeting" restricts results to calendar invitations [30, 6]',
    ceiling: 'nothing matches even with a good plan: "meeting" in the question restricts results to calendar invitations, and this is an ordinary email [6]',
  },
  'draft-reply': { ceiling: 'no tool writes a draft yet: create_draft is Phase 4 [25]' },
};

/**
 * Unread mail labelled `keep` in mailbox.ts that the RETIRED unread review let
 * a careless model mark as read in "Approve for me" (audit, "Fix first",
 * related items). Frozen: it is the baseline the agent replaced it against,
 * and KNOWN_TRIAGE_GAPS may never list anything outside it.
 */
const MODEL_ONLY = 'no host rule protects it, so a confident wrong recommendation marks it as read';
export const RETIRED_REVIEW_TRIAGE_GAPS: Readonly<Record<string, string>> = {
  'tri-po-approved': `a customer's reply approving an order and asking for a document: ${MODEL_ONLY}`,
  'tri-family': `a personal message from a family member: ${MODEL_ONLY}`,
  'tri-site-visit': `a customer's direct question that needs an answer today: ${MODEL_ONLY}`,
  'tri-corrigendum': `a tender deadline moved earlier: ${MODEL_ONLY}`,
};

/**
 * Unread mail labelled `keep` that the agent, with a model that wants
 * everything marked as read, still marks as read in "Approve for me": no host
 * rule protects it, so the model's own judgement is the only gate
 * (review-safety.test.ts). Same two rules as KNOWN_GAPS.
 */
export const KNOWN_TRIAGE_GAPS: Record<string, string> = {
  ...RETIRED_REVIEW_TRIAGE_GAPS,
};
