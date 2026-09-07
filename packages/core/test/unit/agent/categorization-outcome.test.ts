import { describe, expect, it } from 'vitest';

import {
  MAX_AGENT_FAILURES,
  classifyCategorizationPass,
  decideCategorizationAction,
  strikeLimitFor,
  type CategorizationOutcome,
  type CategorizationPass,
} from '../../../src/agent/categorization-outcome';

// These two functions decide, for every categorization pass, whether the email
// is finished or goes back in the queue. The regression they guard is "AI
// categorization silently stops": one arm that retries without a limit is
// enough to leave a row 'pending' for the life of the mailbox, showing the user
// a progress bar parked below 100% with no error and nothing running.
//
// Precedence between the arms is asserted as carefully as the arms themselves,
// because the flags are not mutually exclusive and the wrong winner is silent.

const MAX_PARSE_RETRIES = 3;

const pass = (overrides: Partial<CategorizationPass> = {}): CategorizationPass => ({
  parseFailed: false,
  failed: false,
  skipped: false,
  aiDisabledByUser: false,
  ...overrides,
});

describe('classifyCategorizationPass', () => {
  it('reports success when nothing went wrong', () => {
    expect(classifyCategorizationPass(pass())).toBe('success');
  });

  it('distinguishes a thrown call from a garbled response', () => {
    expect(classifyCategorizationPass(pass({ failed: true }))).toBe('call-failure');
    expect(classifyCategorizationPass(pass({ parseFailed: true }))).toBe('parse-failure');
  });

  // A deterministic defect must not be handed the transient path's ten
  // attempts — that is ten identical failed LLM calls per doomed email, every
  // poll, for nothing.
  it('lets a parse failure outrank a thrown call', () => {
    expect(classifyCategorizationPass(pass({ parseFailed: true, failed: true })))
      .toBe('parse-failure');
  });

  // These two need OPPOSITE treatment — one finalizes the email, the other
  // keeps it pending. Getting the pair backwards leaves mail either permanently
  // uncategorized or permanently pending, and both fail quietly.
  it('separates AI switched off from AI not ready yet', () => {
    expect(classifyCategorizationPass(pass({ skipped: true, aiDisabledByUser: true })))
      .toBe('ai-off');
    expect(classifyCategorizationPass(pass({ skipped: true, aiDisabledByUser: false })))
      .toBe('not-ready');
  });

  // "No provider anywhere" must finalize like ai-off, NOT loop as not-ready:
  // with AI Assist on but nothing configured (and nothing persisted), every poll
  // otherwise re-selects, re-scores and re-logs the row forever and the bar
  // never reaches 100%. This is the fix for the "AI pipeline churns with hasAI=false"
  // report.
  it('finalizes as no-provider when AI is on but nothing is configured anywhere', () => {
    expect(classifyCategorizationPass(pass({ skipped: true, aiDisabledByUser: false, providerConfigured: false })))
      .toBe('no-provider');
  });

  // A provider that EXISTS but isn't applied yet (startup race / global pause)
  // must stay not-ready so a real, temporary outage retries instead of giving up.
  it('keeps not-ready when a provider exists but is merely unavailable', () => {
    expect(classifyCategorizationPass(pass({ skipped: true, aiDisabledByUser: false, providerConfigured: true })))
      .toBe('not-ready');
  });

  // Omitting the flag is the conservative default: treat the skip as not-ready
  // (a provider is presumed to exist) rather than accidentally finalizing mail.
  it('defaults an unspecified provider state to not-ready, never no-provider', () => {
    expect(classifyCategorizationPass(pass({ skipped: true, aiDisabledByUser: false })))
      .toBe('not-ready');
  });

  // A pass that made a call cannot also have skipped it; if both flags somehow
  // arrive set, the failure is the real event and must not be swallowed as a
  // skip (which burns no strikes and would retry forever).
  it('treats a failure as a failure even if the skip flag is also set', () => {
    expect(classifyCategorizationPass(pass({ failed: true, skipped: true })))
      .toBe('call-failure');
  });
});

describe('strikeLimitFor', () => {
  it('gives the transient path a bigger budget than the deterministic one', () => {
    expect(strikeLimitFor('parse-failure', MAX_PARSE_RETRIES)).toBe(MAX_PARSE_RETRIES);
    expect(strikeLimitFor('call-failure', MAX_PARSE_RETRIES)).toBe(MAX_AGENT_FAILURES);
    expect(MAX_AGENT_FAILURES).toBeGreaterThan(MAX_PARSE_RETRIES);
  });

  // THE rule worth stating out loud. AI being unavailable is global and has its
  // own error banner. Charging every email a strike for it would burn the whole
  // mailbox's retry budget during one outage and finalize thousands of emails
  // uncategorized — a far worse and far quieter bug than the one being fixed.
  it('charges no strike for outcomes that are not the email\'s fault', () => {
    expect(strikeLimitFor('not-ready', MAX_PARSE_RETRIES)).toBeNull();
    expect(strikeLimitFor('ai-off', MAX_PARSE_RETRIES)).toBeNull();
    expect(strikeLimitFor('no-provider', MAX_PARSE_RETRIES)).toBeNull();
    expect(strikeLimitFor('success', MAX_PARSE_RETRIES)).toBeNull();
  });
});

describe('decideCategorizationAction', () => {
  it('finalizes a successful pass', () => {
    expect(decideCategorizationAction('success', 0, MAX_PARSE_RETRIES))
      .toEqual({ type: 'finalize', outcome: 'success' });
  });

  // With AI off nothing is ever coming, so retrying is pure loop. Finalizing
  // keeps the local behaviour score and lets the bar read 100% honestly.
  it('finalizes immediately when AI is off by the user\'s choice', () => {
    expect(decideCategorizationAction('ai-off', 0, MAX_PARSE_RETRIES))
      .toEqual({ type: 'finalize', outcome: 'ai-off' });
  });

  // No provider anywhere is as terminal as ai-off — retrying is pure loop, so it
  // finalizes on the first pass and the row stops being re-selected.
  it('finalizes immediately when no provider is configured anywhere', () => {
    expect(decideCategorizationAction('no-provider', 0, MAX_PARSE_RETRIES))
      .toEqual({ type: 'finalize', outcome: 'no-provider' });
  });

  it('retries a thrown call until its budget is spent, then finalizes', () => {
    for (let strikes = 1; strikes < MAX_AGENT_FAILURES; strikes++) {
      expect(decideCategorizationAction('call-failure', strikes, MAX_PARSE_RETRIES).type)
        .toBe('retry');
    }
    expect(decideCategorizationAction('call-failure', MAX_AGENT_FAILURES, MAX_PARSE_RETRIES))
      .toEqual({ type: 'finalize', outcome: 'call-failure' });
  });

  // A connection blip must survive its first couple of failures — giving up on
  // strike one would un-categorize mail over a momentary network hiccup.
  it('does not give up on the first transient failure', () => {
    expect(decideCategorizationAction('call-failure', 1, MAX_PARSE_RETRIES).type).toBe('retry');
  });

  it('retries a parse failure only up to the tighter parse budget', () => {
    expect(decideCategorizationAction('parse-failure', MAX_PARSE_RETRIES - 1, MAX_PARSE_RETRIES).type)
      .toBe('retry');
    expect(decideCategorizationAction('parse-failure', MAX_PARSE_RETRIES, MAX_PARSE_RETRIES))
      .toEqual({ type: 'finalize', outcome: 'parse-failure' });
  });

  // Deliberate and documented: this is the one arm that retries without a
  // limit, and it is correct because the condition is global, not per-email —
  // it resolves for the whole mailbox at once when AI becomes usable. Pinned
  // here so a future change to it is a decision, not an accident.
  it('keeps retrying while AI is merely not ready yet', () => {
    expect(decideCategorizationAction('not-ready', 9999, MAX_PARSE_RETRIES))
      .toEqual({ type: 'retry', outcome: 'not-ready', strikes: 9999, limit: null });
  });

  // The invariant the progress bar depends on: apart from the global
  // 'not-ready' state above, no outcome can retry forever. If someone adds an
  // outcome and forgets its budget, this fails.
  it('every email-level outcome terminates within its budget', () => {
    const outcomes: CategorizationOutcome[] =
      ['success', 'parse-failure', 'call-failure', 'ai-off', 'no-provider'];
    for (const outcome of outcomes) {
      const limit = strikeLimitFor(outcome, MAX_PARSE_RETRIES) ?? 0;
      expect(decideCategorizationAction(outcome, limit, MAX_PARSE_RETRIES).type)
        .toBe('finalize');
    }
  });
});
