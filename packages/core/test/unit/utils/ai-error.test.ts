import { describe, it, expect } from 'vitest';

import { classifyAIError } from '../../../src/utils/ai-error';

// This classifier decides, after AI categorization stops mid-run, whether to show
// the user a "Fix your provider" banner (terminal) or silently auto-restart
// (transient). Both mistakes are bad: a transient error marked terminal nags the
// user about a network blip and leaves AI off; a terminal error marked transient
// spins a retry loop forever against an invalid key or an empty wallet.

const withStatus = (message: string, status: number) => Object.assign(new Error(message), { status });

describe('classifyAIError — Sarv CAI specifics take precedence', () => {
  // The provider's own guidance is far more actionable than "auth failed", so the
  // CAI checks must run before the generic 401/403 handling.
  it('surfaces the "link your CAI org" guidance and wins over a 403 status', () => {
    const info = classifyAIError(withStatus('cai_account_required', 403));
    expect(info.kind).toBe('auth');
    expect(info.terminal).toBe(true);
    expect(info.status).toBe(403);
    expect(info.reason).toMatch(/CAI organization/i);
  });

  it('recognises the prose form of the same failure', () => {
    expect(classifyAIError(new Error('This account is not linked to a CAI org')).reason).toMatch(/CAI organization/i);
  });

  it('surfaces the missing-LLM-scope guidance for insufficient_scope / insufficient_role', () => {
    for (const message of ['insufficient_scope', 'insufficient_role']) {
      const info = classifyAIError(new Error(message));
      expect(info.kind).toBe('auth');
      expect(info.terminal).toBe(true);
      expect(info.reason).toMatch(/lacks the required LLM access/i);
    }
  });
});

describe('classifyAIError — credit / billing is terminal', () => {
  it('classifies HTTP 402 as a credit problem', () => {
    const info = classifyAIError({ status: 402 });
    expect(info).toMatchObject({ kind: 'credit', terminal: true, status: 402 });
  });

  it('recognises the provider-specific out-of-credit wordings', () => {
    for (const message of [
      'insufficient_balance',
      'insufficient balance',
      'insufficient_quota',
      'insufficient funds',
      'You exceeded your current quota',
      'Payment Required',
      'billing details required',
      'out of credit',
      'no credit remaining',
      'please add credit',
      'top up your account',
      'topup required',
    ]) {
      expect(classifyAIError(new Error(message)).kind).toBe('credit');
    }
  });

  // ORDERING REGRESSION: OpenAI dresses "you're out of money" up as a 429. If the
  // rate-limit check ran first we would retry forever instead of telling the user.
  it('classifies an out-of-quota 429 as credit (terminal), NOT a rate limit', () => {
    const info = classifyAIError(withStatus('Rate limit reached: insufficient_quota', 429));
    expect(info.kind).toBe('credit');
    expect(info.terminal).toBe(true);
  });

  // Non-Error throws (a rejected string from a fetch wrapper) must classify too.
  it('classifies a non-Error value by its text', () => {
    expect(classifyAIError('insufficient balance').kind).toBe('credit');
  });
});

describe('classifyAIError — auth is terminal', () => {
  it('classifies 401 and 403 as auth', () => {
    expect(classifyAIError({ status: 401 })).toMatchObject({ kind: 'auth', terminal: true });
    expect(classifyAIError({ status: 403 })).toMatchObject({ kind: 'auth', terminal: true });
  });

  it('classifies an auth-shaped message with no status', () => {
    const info = classifyAIError(new Error('Invalid credentials supplied'));
    expect(info.kind).toBe('auth');
    expect(info.terminal).toBe(true);
    expect(info.status).toBeUndefined();
    expect(info.reason).toMatch(/API key/i);
  });

  // Some SDKs expose `statusCode` rather than `status`; both must be read or a
  // hard 401 silently becomes an "unknown, keep retrying".
  it('reads statusCode as well as status', () => {
    expect(classifyAIError(Object.assign(new Error('nope'), { statusCode: 401 }))).toMatchObject({
      kind: 'auth',
      status: 401,
    });
  });
});

describe('classifyAIError — transient failures keep retrying', () => {
  it('classifies 429 as a rate limit (not terminal)', () => {
    expect(classifyAIError({ status: 429 })).toMatchObject({ kind: 'rate_limit', terminal: false });
  });

  it('classifies an ETHROTTLE code as a rate limit', () => {
    expect(classifyAIError(Object.assign(new Error('slow down'), { code: 'ETHROTTLE' })).kind).toBe('rate_limit');
  });

  it('classifies gateway errors as upstream (not terminal)', () => {
    expect(classifyAIError(withStatus('bad gateway', 502))).toMatchObject({ kind: 'upstream', terminal: false });
    expect(classifyAIError(new Error('503 Service Unavailable')).kind).toBe('upstream');
    expect(classifyAIError(new Error('gateway timeout')).kind).toBe('upstream');
  });

  it('classifies socket / DNS failures as network (not terminal)', () => {
    expect(classifyAIError(new Error('socket hang up'))).toMatchObject({ kind: 'network', terminal: false });
    expect(classifyAIError(new Error('ETIMEDOUT connect'))).toMatchObject({ kind: 'network', terminal: false });
  });

  it('classifies HTTP 408 and timeout wording as a timeout (not terminal)', () => {
    expect(classifyAIError({ status: 408 })).toMatchObject({ kind: 'timeout', terminal: false });
    // A non-Error value skips the socket-level predicates and lands on the wording.
    expect(classifyAIError('the operation timed out')).toMatchObject({ kind: 'timeout', terminal: false });
    expect(classifyAIError('request timeout')).toMatchObject({ kind: 'timeout', terminal: false });
  });

  it('classifies a generic 5xx as a server error (not terminal)', () => {
    expect(classifyAIError({ status: 500 })).toMatchObject({ kind: 'server', terminal: false });
    expect(classifyAIError({ status: 599 })).toMatchObject({ kind: 'server', terminal: false });
  });
});

describe('classifyAIError — other 4xx is terminal', () => {
  // A malformed request or a wrong model name will be rejected identically on
  // every retry, so retrying is pure waste — surface it instead.
  it('classifies a non-auth 4xx as a terminal client error naming the status', () => {
    const info = classifyAIError({ status: 400 });
    expect(info).toMatchObject({ kind: 'client', terminal: true, status: 400 });
    expect(info.reason).toContain('HTTP 400');

    expect(classifyAIError({ status: 404 })).toMatchObject({ kind: 'client', terminal: true });
    expect(classifyAIError({ status: 422 })).toMatchObject({ kind: 'client', terminal: true });
  });
});

describe('classifyAIError — unknown falls back to retrying', () => {
  // Default to transient: an unrecognised blip should not permanently disable AI
  // and pester the user with a Fix banner.
  it('classifies an unrecognised error as unknown and NOT terminal', () => {
    const info = classifyAIError(new Error('something odd happened'));
    expect(info).toMatchObject({ kind: 'unknown', terminal: false });
    expect(info.status).toBeUndefined();
    expect(info.reason).toBe('The AI provider request failed.');
  });

  it('mentions the status when there is one it does not otherwise recognise', () => {
    const info = classifyAIError({ status: 300 });
    expect(info).toMatchObject({ kind: 'unknown', terminal: false, status: 300 });
    expect(info.reason).toContain('HTTP 300');
  });

  it('never throws on null, undefined or a non-numeric status', () => {
    expect(classifyAIError(null)).toMatchObject({ kind: 'unknown', terminal: false });
    expect(classifyAIError(undefined)).toMatchObject({ kind: 'unknown', terminal: false });
    expect(classifyAIError({ status: '401' })).toMatchObject({ kind: 'unknown', status: undefined });
  });

  // Every result must be renderable in the banner — an empty reason would show a
  // blank "AI is inactive" strip.
  it('always returns a non-empty reason', () => {
    const samples: unknown[] = [null, 'x', new Error('y'), { status: 402 }, { status: 429 }, { status: 400 }];
    for (const sample of samples) {
      expect(classifyAIError(sample).reason.length).toBeGreaterThan(0);
    }
  });
});
