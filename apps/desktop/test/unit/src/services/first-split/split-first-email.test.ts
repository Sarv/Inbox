// @vitest-environment happy-dom
// Regions are cut and output bodies cleaned with the DOM.
import { nextFailureState, type FirstSplitKey } from '@sarvinbox/core/first-split';
import { describe, expect, it, vi } from 'vitest';

import { splitThread } from '../../../../../src/components/email-detail/chat-message-adapter';
import { SarvLLMError } from '../../../../../src/services/ai-service';
import { regionMarker } from '../../../../../src/services/first-split/prompt';
import {
  classifySplitError,
  splitFirstEmail,
  type CompleteFn,
} from '../../../../../src/services/first-split/split-first-email';
import { email } from '../../components/email-detail/email-fixture';
import {
  ALICE_TEXT,
  BOB_TEXT,
  CAROL_TEXT,
  DAN_TEXT,
  GERMAN_BODY,
  LOOPED_AT,
  loopedInEmail,
  OUTLOOK_PLAIN_BODY,
  PRIYA_TEXT,
  ROSTER,
} from '../../components/email-detail/looped-in-fixture';

/**
 * One split run, with a fake `complete`.
 *
 * What breaks if this file goes red: a transient failure (rate limit, gateway
 * blip, timeout, network) is recorded as permanent and the thread is never
 * split again — or a permanent one is retried forever at the provider's
 * expense; a provider-wide problem (bad key, no credit) marks every thread the
 * reader opens as failed; or half a split is stored as a success.
 */

const E1 = loopedInEmail();
const STANDARD = splitThread([E1], { currentUserEmail: '' });
const input = (overrides: Partial<Parameters<typeof splitFirstEmail>[0]> = {}) => ({
  source: E1,
  roster: ROSTER,
  standard: STANDARD,
  ...overrides,
});
const deps = (complete: CompleteFn) => ({ complete, regionOptions: { registerImage: (src: string) => src }, now: () => LOOPED_AT });

const answer = (messages: unknown[]) => JSON.stringify({ messages });
const entry = (region: number, text: string, from = '') => ({ region, from_address: from, from_name: null, date: '', body: `<div>${text}</div>` });
const FULL = answer([
  entry(3, ALICE_TEXT, 'alice@acme.example'),
  entry(2, BOB_TEXT, 'bob@acme.example'),
  entry(1, CAROL_TEXT, 'carol@acme.example'),
  entry(0, DAN_TEXT, 'dan@acme.example'),
]);

const httpError = (status: number, message = `HTTP ${status}`) => Object.assign(new Error(message), { status });

describe('splitFirstEmail — success', () => {
  it('splits the first email into ok parts in one call', async () => {
    const complete = vi.fn<CompleteFn>(async () => FULL);
    const outcome = await splitFirstEmail(input(), deps(complete));
    expect(outcome).toMatchObject({ status: 'ok', regions: 4, chunks: 1, aiParts: 4, fallbackParts: 0 });
    expect(outcome.parts!.map((part) => part.role)).toEqual(['quote', 'quote', 'quote', 'own']);
    expect(complete).toHaveBeenCalledTimes(1);
    const request = complete.mock.calls[0]![0]!;
    expect(request).toMatchObject({ responseFormat: 'json_object' });
    expect(request.maxTokens).toBeGreaterThan(0);
    for (const index of [0, 1, 2, 3]) expect(request.userPrompt).toContain(regionMarker(index));
  });

  it('is partial when the model skipped a message Standard had', async () => {
    const skipped = answer([entry(3, ALICE_TEXT), entry(1, CAROL_TEXT), entry(0, DAN_TEXT)]);
    const outcome = await splitFirstEmail(input(), deps(async () => skipped));
    expect(outcome).toMatchObject({ status: 'partial', fallbackParts: 1 });
  });

  // Regression (blocker): a first email whose boundaries the library does
  // not recognise is one region and one Standard segment; the own part was
  // the model's oldest entry (Alice's words under Dan's name), and a skipped
  // message still came out ok.
  describe.each([
    ['an Outlook plain-div chain', OUTLOOK_PLAIN_BODY],
    ['a German "Am … schrieb" chain', GERMAN_BODY],
  ])('with no recognised boundary: %s', (_name, rawBody) => {
    const source = loopedInEmail({ rawBody });
    const unsplit = input({ source, standard: splitThread([source], { currentUserEmail: '' }) });
    const messages = [
      entry(0, ALICE_TEXT, 'alice@acme.example'),
      entry(0, BOB_TEXT, 'bob@acme.example'),
      entry(0, CAROL_TEXT, 'carol@acme.example'),
      entry(0, PRIYA_TEXT, 'dan@acme.example'),
    ];

    it('gives the sender’s own entry as the own part', async () => {
      const outcome = await splitFirstEmail(unsplit, deps(async () => answer(messages)));
      expect(outcome).toMatchObject({ status: 'ok', regions: 1, chunks: 1, aiParts: 4, fallbackParts: 0 });
      const own = outcome.parts!.filter((part) => part.role === 'own');
      expect(own).toEqual([expect.objectContaining({ fromAddress: 'dan@acme.example', fallback: false })]);
      expect(own[0]!.body).toContain(PRIYA_TEXT);
      expect(outcome.parts!.filter((part) => part.role === 'quote').map((part) => part.fromAddress))
        .toEqual(['alice@acme.example', 'bob@acme.example', 'carol@acme.example']);
    });

    // Breaks: a split that lost a message is saved as a success. (Behaviour
    // changed: it is `transient`/`unusable` — one retry — no longer `failed`
    // after a single non-deterministic answer.)
    it('is unusable, not ok, when the model skipped a message', async () => {
      const outcome = await splitFirstEmail(unsplit, deps(async () => answer(messages.slice(1))));
      expect(outcome).toMatchObject({ status: 'transient', errorKind: 'unusable' });
      expect(outcome.parts).toBeUndefined();
    });
  });

  it('passes the provider’s status text through', async () => {
    const onStatus = vi.fn();
    const complete: CompleteFn = async (options) => {
      options.onStatus?.('AI provider busy — retrying in 8s');
      return FULL;
    };
    await splitFirstEmail(input({ onStatus }), deps(complete));
    expect(onStatus).toHaveBeenCalledWith('AI provider busy — retrying in 8s');
  });

  // A cut-off answer is never an ok: its last entry is not trusted.
  it('is partial when the answer was cut off', async () => {
    const outcome = await splitFirstEmail(input(), deps(async () => FULL.slice(0, -40)));
    expect(outcome.status).toBe('partial');
  });

  // No readable date and no From address: the run still splits; the header
  // simply omits what it does not know.
  it('splits a first email with no readable date or sender', async () => {
    const complete = vi.fn<CompleteFn>(async () => FULL);
    const bare = loopedInEmail({ date: 0, fromAddress: '' });
    const outcome = await splitFirstEmail(input({ source: bare, standard: splitThread([bare], { currentUserEmail: '' }) }), deps(complete));
    expect(outcome.status).not.toBe('failed');
    expect(complete.mock.calls[0]![0]!.userPrompt).toContain('Date: \n');
    expect(outcome.parts!.every((part) => part.date > 0)).toBe(true);
  });

  it('counts the outputs it rejected', async () => {
    const withJunk = answer([entry(1, CAROL_TEXT), entry(7, BOB_TEXT), entry(2, 'invented and never in the email at all, not grounded'), entry(0, DAN_TEXT)]);
    const outcome = await splitFirstEmail(input(), deps(async () => withJunk));
    expect(outcome.rejected).toEqual({ region: 1, ungrounded: 1 });
  });
});

describe('splitFirstEmail — failures', () => {
  // Transient: it may fix itself. No parts: a half-run is never a success.
  it.each([
    ['a rate limit (429)', httpError(429)],
    ['a gateway error (503)', httpError(503)],
    ['a timeout SarvLLMError(504)', new SarvLLMError(504, JSON.stringify({ error: 'timeout' }))],
    ['a network failure', new TypeError('Failed to fetch')],
  ])('treats %s as transient, with no parts', async (_label, error) => {
    const outcome = await splitFirstEmail(input(), deps(async () => { throw error; }));
    expect(outcome.status).toBe('transient');
    expect(outcome.parts).toBeUndefined();
    expect(outcome.errorKind).toBeTruthy();
  });

  // Provider-wide: not this thread's problem — no row is written for it.
  it.each([
    ['an auth failure (401)', new SarvLLMError(401, '{}')],
    ['no credit (402)', new SarvLLMError(402, '{}')],
    ['no provider', new Error('No AI provider configured')],
  ])('treats %s as provider-wide', async (_label, error) => {
    const outcome = await splitFirstEmail(input(), deps(async () => { throw error; }));
    expect(outcome.status).toBe('provider');
    expect(outcome.parts).toBeUndefined();
    expect(outcome.errorKind).toBeUndefined();
  });

  // A 4xx is the provider's verdict on the request: permanent for this
  // provider (the store records the provider signature with it).
  it('treats a 400 as failed/client', async () => {
    const outcome = await splitFirstEmail(input(), deps(async () => { throw new SarvLLMError(400, '{}'); }));
    expect(outcome).toMatchObject({ status: 'failed', errorKind: 'client' });
  });

  // Models are not deterministic: one malformed answer is retried; a second
  // one in a row is a verdict (the cache's failure policy escalates it).
  it('treats an unparseable answer as transient, then failed on the second attempt', async () => {
    const outcome = await splitFirstEmail(input(), deps(async () => 'Sorry, I cannot help with that.'));
    expect(outcome).toMatchObject({ status: 'transient', errorKind: 'unparseable' });
    const key: FirstSplitKey = { threadId: 't1', firstKey: 'k', firstEmailId: 'e1', fingerprint: 'f' };
    const first = nextFailureState(null, key, { status: 'transient', errorKind: 'unparseable' }, LOOPED_AT);
    const stored = {
      threadId: 't1', firstKey: 'k', firstEmailId: 'e1', sourceFingerprint: 'f', splitVersion: 1,
      status: first.status, quoteCount: 3, parts: null, errorKind: 'unparseable', attempts: first.attempts,
      nextRetryAt: first.nextRetryAt, modelUsed: null, updatedAt: LOOPED_AT,
    };
    expect(nextFailureState(stored, key, { status: 'transient', errorKind: 'unparseable' }, LOOPED_AT).status).toBe('failed');
  });

  it('treats an empty answer as transient', async () => {
    expect(await splitFirstEmail(input(), deps(async () => '   '))).toMatchObject({ status: 'transient', errorKind: 'empty' });
  });

  // Breaks: ONE answer whose outputs all fail the checks (models are not
  // deterministic) made the thread permanently failed, while an unparseable
  // answer got a retry for exactly that reason. Now it is transient/unusable,
  // and the cache's failure policy makes the second bad answer in a row final.
  it('treats an answer with no usable output as transient, then failed on the second', async () => {
    const junk = answer([entry(1, 'a paraphrase that is nowhere in the email text whatsoever, invented')]);
    const outcome = await splitFirstEmail(input(), deps(async () => junk));
    expect(outcome).toMatchObject({ status: 'transient', errorKind: 'unusable' });
    expect(outcome.parts).toBeUndefined();
    const key: FirstSplitKey = { threadId: 't1', firstKey: 'k', firstEmailId: 'e1', fingerprint: 'f' };
    const first = nextFailureState(null, key, { status: 'transient', errorKind: 'unusable' }, LOOPED_AT);
    expect(first.status).toBe('transient');
    const stored = {
      threadId: 't1', firstKey: 'k', firstEmailId: 'e1', sourceFingerprint: 'f', splitVersion: 1,
      status: first.status, quoteCount: 3, parts: null, errorKind: 'unusable', attempts: first.attempts,
      nextRetryAt: first.nextRetryAt, modelUsed: null, updatedAt: LOOPED_AT,
    };
    expect(nextFailureState(stored, key, { status: 'transient', errorKind: 'unusable' }, LOOPED_AT).status).toBe('failed');
  });

  // Named limitation: one region with no cut point, over budget.
  it('fails as too_large without calling the model for a huge body with no boundaries', async () => {
    const complete = vi.fn(async () => FULL);
    const huge = email({ id: 'e1', date: LOOPED_AT, rawBody: `<p>${'word '.repeat(12_000)}</p>` });
    const outcome = await splitFirstEmail(input({ source: huge, standard: [] }), deps(complete));
    expect(outcome).toMatchObject({ status: 'failed', errorKind: 'too_large' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('fails as unusable for a body with nothing to send', async () => {
    const complete = vi.fn(async () => FULL);
    const blank = email({ id: 'e1', date: LOOPED_AT, rawBody: '<div class="gmail_quote"></div>' });
    expect(await splitFirstEmail(input({ source: blank, standard: [] }), deps(complete))).toMatchObject({ status: 'failed', errorKind: 'unusable' });
    expect(await splitFirstEmail(input({ source: email({ id: 'e1', rawBody: '' }) }), deps(complete))).toMatchObject({ status: 'failed', errorKind: 'unusable' });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('splitFirstEmail — chunks', () => {
  /** A history too long for one request: two quoted regions of ~20K each. */
  const LONG_A = `${CAROL_TEXT} `.repeat(170);
  const LONG_B = `${BOB_TEXT} `.repeat(170);
  const longEmail = email({
    id: 'e1',
    date: LOOPED_AT,
    fromAddress: 'dan@acme.example',
    rawBody: [
      `<div>${DAN_TEXT}</div>`,
      '<div class="gmail_quote"><div class="gmail_attr">On Tue, 3 Mar 2026 at 09:00, Carol Diaz &lt;carol@acme.example&gt; wrote:<br></div>',
      `<blockquote class="gmail_quote"><div>${LONG_A}</div>`,
      '<div class="gmail_quote"><div class="gmail_attr">On Mon, 2 Mar 2026 at 18:00, Bob Ray &lt;bob@acme.example&gt; wrote:<br></div>',
      `<blockquote class="gmail_quote"><div>${LONG_B}</div></blockquote></div></blockquote></div>`,
    ].join(''),
  });
  const longInput = () => input({ source: longEmail, standard: splitThread([longEmail], { currentUserEmail: '' }) });

  it('sends a long history in several chunks and assembles one split', async () => {
    const complete = vi.fn<CompleteFn>()
      .mockResolvedValueOnce(answer([entry(1, LONG_A, 'carol@acme.example'), entry(0, DAN_TEXT, 'dan@acme.example')]))
      .mockResolvedValueOnce(answer([entry(2, LONG_B, 'bob@acme.example')]));
    const outcome = await splitFirstEmail(longInput(), deps(complete));
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[1]![0].systemPrompt).not.toContain('LAST entry');
    expect(outcome).toMatchObject({ status: 'ok', chunks: 2 });
    expect(outcome.parts!.map((part) => part.fromAddress)).toEqual(['bob@acme.example', 'carol@acme.example', 'dan@acme.example']);
  });

  // THE partial-run rule: chunk 2 failing transiently after chunk 1 worked
  // makes the WHOLE run transient — half a split stored as a success would
  // never be retried.
  it('makes the whole run transient when a later chunk fails transiently', async () => {
    const complete = vi.fn<CompleteFn>()
      .mockResolvedValueOnce(answer([entry(1, LONG_A), entry(0, DAN_TEXT)]))
      .mockRejectedValueOnce(httpError(503));
    const outcome = await splitFirstEmail(longInput(), deps(complete));
    expect(outcome.status).toBe('transient');
    expect(outcome.parts).toBeUndefined();
  });
});

describe('classifySplitError', () => {
  it('maps every AI error kind onto an outcome', () => {
    expect(classifySplitError(httpError(401))).toMatchObject({ status: 'provider' });
    expect(classifySplitError(httpError(404))).toMatchObject({ status: 'failed', errorKind: 'client' });
    expect(classifySplitError(httpError(500))).toMatchObject({ status: 'transient', errorKind: 'server' });
    expect(classifySplitError('weird')).toMatchObject({ status: 'transient', errorKind: 'unknown' });
    expect(classifySplitError(undefined)).toMatchObject({ status: 'transient' });
  });
});
