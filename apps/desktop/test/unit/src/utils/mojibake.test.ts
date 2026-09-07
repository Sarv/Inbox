import { describe, it, expect } from 'vitest';

import { hasReplacementChar, cacheHasHealedMojibake } from '../../../../src/utils/mojibake';

const FFFD = '�';

describe('hasReplacementChar', () => {
  it('detects the replacement char', () => {
    expect(hasReplacementChar(`hello ${FFFD} world`)).toBe(true);
  });
  it('is false for clean text', () => {
    expect(hasReplacementChar('Hi Simran/Mitali,')).toBe(false);
  });
  it('is false for empty/nullish', () => {
    expect(hasReplacementChar('')).toBe(false);
    expect(hasReplacementChar(null)).toBe(false);
    expect(hasReplacementChar(undefined)).toBe(false);
  });
});

describe('cacheHasHealedMojibake', () => {
  it('flags a garbled bubble whose source body is now clean (healed → stale cache)', () => {
    const bubbles = [{ body: `${FFFD}○${FFFD}杙${FFFD}Z`, sourceEmailId: 'e1' }];
    const sources = [{ id: 'e1', rawBody: '<p>Could you clarify the session token?</p>', cleanBody: 'Could you clarify' }];
    expect(cacheHasHealedMojibake(bubbles, sources)).toBe(true);
  });

  it('does NOT flag when the source body is still corrupt (heal pending — avoid LLM churn)', () => {
    const bubbles = [{ body: `${FFFD}○${FFFD}杙`, sourceEmailId: 'e1' }];
    const sources = [{ id: 'e1', rawBody: `still ${FFFD} garbled`, cleanBody: `still ${FFFD} garbled` }];
    expect(cacheHasHealedMojibake(bubbles, sources)).toBe(false);
  });

  it('does NOT flag a clean cache', () => {
    const bubbles = [{ body: 'Perfectly fine text', sourceEmailId: 'e1' }];
    const sources = [{ id: 'e1', rawBody: 'Perfectly fine text', cleanBody: 'Perfectly fine text' }];
    expect(cacheHasHealedMojibake(bubbles, sources)).toBe(false);
  });

  it('does NOT flag when the source email is missing (left to backfill)', () => {
    const bubbles = [{ body: `${FFFD}${FFFD}`, sourceEmailId: 'gone' }];
    const sources = [{ id: 'e1', rawBody: 'clean', cleanBody: 'clean' }];
    expect(cacheHasHealedMojibake(bubbles, sources)).toBe(false);
  });

  it('flags if ANY bubble is a healed-but-stale one', () => {
    const bubbles = [
      { body: 'clean bubble', sourceEmailId: 'e1' },
      { body: `${FFFD}garbled`, sourceEmailId: 'e2' },
    ];
    const sources = [
      { id: 'e1', rawBody: 'clean', cleanBody: 'clean' },
      { id: 'e2', rawBody: 'now clean', cleanBody: 'now clean' },
    ];
    expect(cacheHasHealedMojibake(bubbles, sources)).toBe(true);
  });
});
