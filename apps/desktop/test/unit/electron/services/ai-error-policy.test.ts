import { describe, it, expect } from 'vitest';

import { decideAIErrorPolicy } from '../../../../electron/services/ai-error-policy';

// The pause policy decides whether an AI error stops the WHOLE mailbox or just
// fails one email. Getting this wrong either (a) pauses categorization forever on
// a single bad message, or (b) hammers a doomed provider every 30s on a bad key.

// Fake classifier so the policy is tested independently of the classifier's regexes.
// Cast to the exact injectable param type (its `kind` is a string-literal union).
type ClassifyArg = Parameters<typeof decideAIErrorPolicy>[1];
const classify = (info: { terminal: boolean; kind: string; status?: number; reason: string }): ClassifyArg =>
  (() => info) as unknown as ClassifyArg;

describe('decideAIErrorPolicy', () => {
  it('is NOT terminal for a transient error (keep retrying, never pause)', () => {
    const d = decideAIErrorPolicy({}, classify({ terminal: false, kind: 'network', status: 0, reason: 'blip' }));
    expect(d).toMatchObject({ terminal: false, pauseGlobally: false });
  });

  it('pauses globally for a provider-wide AUTH failure (bad/expired key)', () => {
    const d = decideAIErrorPolicy({}, classify({ terminal: true, kind: 'auth', status: 401, reason: 'key invalid' }));
    expect(d).toMatchObject({ terminal: true, pauseGlobally: true, kind: 'auth', reason: 'key invalid' });
  });

  it('pauses globally for a CREDIT/billing failure', () => {
    const d = decideAIErrorPolicy({}, classify({ terminal: true, kind: 'credit', status: 402, reason: 'out of credits' }));
    expect(d.pauseGlobally).toBe(true);
  });

  it('is terminal but does NOT pause globally for a per-email client 4xx', () => {
    // One malformed message the provider rejects must fail just that email, not
    // pause categorization for the whole mailbox.
    const d = decideAIErrorPolicy({}, classify({ terminal: true, kind: 'client', status: 400, reason: 'bad request' }));
    expect(d).toMatchObject({ terminal: true, pauseGlobally: false });
  });

  it('works with the REAL classifier: an auth-shaped error pauses globally', () => {
    const d = decideAIErrorPolicy(Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 }));
    expect(d.terminal).toBe(true);
    expect(d.pauseGlobally).toBe(true);
    expect(d.kind).toBe('auth');
  });
});
