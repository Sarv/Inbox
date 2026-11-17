/**
 * Cases the Inbox Agent is KNOWN to get wrong today.
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
 * `ceiling` is the run with the case's hand-written ideal plan. A gap listed
 * under `ceiling` cannot be fixed by a better model.
 */
export interface KnownGap { floor?: string; ceiling?: string }

const ARRIVAL_DATE = 'nothing matches: "tomorrow" limits the search to mail that ARRIVES tomorrow, where no mail can exist [6]';
const BURIED = 'the email is found, but the sentence that answers is not in the excerpt that reaches the model [22]';
const NOT_A_SEARCH = 'runs a mailbox search and model calls instead of answering in chat [16]';
const UNSUPPORTED_ACTION = 'an action the agent cannot take is silently turned into a mailbox search [16]';
const NO_STRUCTURED = 'searches for the words of the question instead of reading mailbox state (unread, starred, counts) [19]';
const FOLLOW_UP = 'the follow-up is searched as a new question with none of the first question\'s context [18]';

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

  'review-unread-hinglish': { floor: 'refused with an error: the review request is only understood in English [30]' },
  'mark-sender-read-hinglish': { floor: 'treated as a question and searched: the mark-as-read command is only understood in English [30]' },
  'thanks': { floor: NOT_A_SEARCH },
  'namaste': { floor: NOT_A_SEARCH },
  'who-are-you': { floor: NOT_A_SEARCH },
  'archive-newsletters': { floor: UNSUPPORTED_ACTION },
  'star-this': { floor: UNSUPPORTED_ACTION },
  'count-unread': { floor: NO_STRUCTURED },
  'starred-list': { floor: NO_STRUCTURED },
  'draft-reply': { floor: 'searched as a question: a draft cannot be asked for in chat [25]' },

  'followup-validity': { floor: FOLLOW_UP },
  'followup-when': { floor: FOLLOW_UP },
  'followup-hinglish': { floor: FOLLOW_UP },
};

/**
 * Unread mail labelled `keep` in mailbox.ts that a careless model can still get
 * marked as read in "Approve for me" mode: the host has no rule that protects
 * it, so the model's own confidence is the only gate (audit, "Fix first",
 * related items). Same two rules as above.
 */
const MODEL_ONLY = 'no host rule protects it, so a confident wrong recommendation marks it as read';
export const KNOWN_TRIAGE_GAPS: Record<string, string> = {
  'tri-po-approved': `a customer's reply approving an order and asking for a document: ${MODEL_ONLY}`,
  'tri-family': `a personal message from a family member: ${MODEL_ONLY}`,
  'tri-site-visit': `a customer's direct question that needs an answer today: ${MODEL_ONLY}`,
  'tri-corrigendum': `a tender deadline moved earlier: ${MODEL_ONLY}`,
};
