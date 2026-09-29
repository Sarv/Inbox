import { describe, expect, it } from 'vitest';

import {
  buildSplitPrompt,
  CHARS_PER_TOKEN,
  CHUNK_BUDGET_CHARS,
  HEADER_OVERHEAD_CHARS,
  INPUT_TOKEN_CAP,
  MAX_RESPONSE_TOKENS,
  MIN_RESPONSE_TOKENS,
  MODEL_CONTEXT_TOKENS,
  regionMarker,
  responseBudgetFor,
  SAFETY_MARGIN_TOKENS,
  systemPromptFor,
  userPromptFor,
} from '../../../../../src/services/first-split/prompt';
import type { RegionChunk, SplitRegion } from '../../../../../src/services/first-split/regions';

/**
 * The split prompt and its region protocol.
 *
 * What breaks if this file goes red: for a chunk of history only (a later
 * chunk of a long looped-in chain), the model is told "the From/Date is the
 * LAST entry" and invents a newest message for the sender out of the oldest
 * quote; or a region marker is missing or doubled and the model's answers can
 * no longer be checked against the region they claim; or a full chunk
 * overruns the model's context.
 */

const region = (index: number, html: string): SplitRegion => ({ index, html, text: '', messageChars: 0, attribution: null });
const chunk = (regions: SplitRegion[]): RegionChunk => ({
  regions,
  chars: regions.reduce((sum, each) => sum + each.html.length, 0),
  includesOwnRegion: regions.some((each) => each.index === 0),
});
const CARRIER = { fromAddress: 'dan@acme.example', fromName: 'Dan Moss', toAddress: 'me@acme.example', date: 1772618400 };

describe('systemPromptFor', () => {
  it('states the LAST-entry rule only when the chunk holds the sender’s own region', () => {
    expect(systemPromptFor(true)).toContain('is the LAST entry');
    expect(systemPromptFor(false)).not.toContain('LAST entry');
    expect(systemPromptFor(false)).toContain('never invent a message for the carrier’s sender'.replace('’', "'"));
  });

  // Every entry must name its region, or validation cannot check it.
  it('requires a region on every entry, in both variants', () => {
    for (const own of [true, false]) {
      expect(systemPromptFor(own)).toContain('"region": k');
      expect(systemPromptFor(own)).toContain('"region" is REQUIRED');
    }
  });
});

describe('userPromptFor', () => {
  it('puts every region under its marker, exactly once, in order', () => {
    const text = userPromptFor(chunk([region(0, '<p>own</p>'), region(1, '<p>one</p>'), region(2, '<p>two</p>')]), CARRIER);
    for (const index of [0, 1, 2]) {
      expect(text.split(regionMarker(index)).length - 1).toBe(1);
    }
    expect(text.indexOf(regionMarker(0))).toBeLessThan(text.indexOf(regionMarker(1)));
    expect(text.indexOf('<p>one</p>')).toBeGreaterThan(text.indexOf(regionMarker(1)));
    expect(text).toContain('From: Dan Moss <dan@acme.example>');
    expect(text).toContain('Date: 2026-03-04T10:00:00.000Z');
  });

  // A history-only chunk names the carrier as context, not as a message.
  it('frames a history-only chunk as context, with no From line to copy', () => {
    const text = userPromptFor(chunk([region(3, '<p>old</p>'), region(4, '<p>older</p>')]), CARRIER);
    expect(text).not.toMatch(/^From:/m);
    expect(text).toContain('context only');
    expect(text).not.toContain(regionMarker(0));
  });

  it('omits an unreadable date and a missing display name', () => {
    const text = userPromptFor(chunk([region(0, '<p>own</p>')]), { fromAddress: 'x@y.z', date: 0 });
    expect(text).toContain('From: x@y.z\nTo: \nDate: \n');
  });
});

describe('budgets', () => {
  // A full chunk, with the longer prompt and the header, still fits the cap.
  it('sizes the chunk budget so a full chunk fits the input cap', () => {
    const longest = Math.max(systemPromptFor(true).length, systemPromptFor(false).length);
    expect(CHUNK_BUDGET_CHARS + longest + HEADER_OVERHEAD_CHARS).toBeLessThanOrEqual(INPUT_TOKEN_CAP * CHARS_PER_TOKEN);
    expect(CHUNK_BUDGET_CHARS).toBeGreaterThan(20_000);
  });

  it('gives the response min(16384, 32768 − input − 1000), never under 512', () => {
    expect(responseBudgetFor('', '')).toBe(MAX_RESPONSE_TOKENS);
    const big = 'x'.repeat(Math.ceil(20_000 * CHARS_PER_TOKEN));
    expect(responseBudgetFor(big, '')).toBe(MODEL_CONTEXT_TOKENS - 20_000 - SAFETY_MARGIN_TOKENS);
    expect(responseBudgetFor('x'.repeat(100_000), '')).toBe(MIN_RESPONSE_TOKENS);
  });

  it('builds one request per chunk with its own budget', () => {
    const request = buildSplitPrompt(chunk([region(0, '<p>own</p>')]), CARRIER);
    expect(request.systemPrompt).toBe(systemPromptFor(true));
    expect(request.maxTokens).toBe(responseBudgetFor(request.systemPrompt, request.userPrompt));
  });
});
