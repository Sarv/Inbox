import { describe, expect, it } from 'vitest';

import { ReplyStyleAnalyzer } from '../../../src/agent/reply-style-analyzer';
import type { EmailRecord } from '../../../src/types/models';

// The style analyzer reads the user's sent replies — including the quoted HTML
// of whoever they replied to — and turns them into few-shot samples for the AI.
// Its HTML strip was `/<[^>]+>/g`, quadratic on a body of unclosed `<` (CodeQL
// js/polynomial-redos): 200 K of them took about 14 s per body, on the main
// thread, and it cleans every sampled body twice.

const sent = (over: Partial<EmailRecord>): EmailRecord => ({
  id: 's1',
  fromAddress: 'me@example.com',
  toAddress: 'sam@client.example',
  subject: 'Re: Plan',
  inReplyTo: '<orig@client.example>',
  cleanBody: '',
  rawBody: '',
  date: 1_790_000_000,
  ...over,
}) as EmailRecord;

describe('ReplyStyleAnalyzer — reply body cleaning', () => {
  // Breaks: tags, quoted lines or the attribution leak into the samples the AI
  // imitates, or the reply's own words are lost.
  it('samples only the words of the reply itself', async () => {
    const profile = await new ReplyStyleAnalyzer().analyzeStyle([sent({
      rawBody: '<p>Hi Sam,</p>\nSounds good, see you <b>Tuesday</b>.\nOn Mon, Sam wrote:\n> are we on?\n--\nMe',
    })]);
    expect(profile.sampleReplies[0].body).toBe('Hi Sam,\nSounds good, see you Tuesday.');
    expect(profile.greetingPatterns).toEqual(['Hi Sam,']);
  });

  // Breaks: one sent mail quoting a crafted body of unclosed `<` stalls the
  // style analysis for seconds — the regex strip is back.
  it('cleans a body of 200 K unclosed "<" at once', async () => {
    const profile = await new ReplyStyleAnalyzer().analyzeStyle([sent({ rawBody: '<'.repeat(200_000) })]);
    expect(profile.analyzedCount).toBe(0);
  });

  // Breaks: a stray `<` (or a half tag) survives into the AI's style sample.
  it('leaves no "<" in a sample', async () => {
    const profile = await new ReplyStyleAnalyzer().analyzeStyle([sent({
      rawBody: 'Thanks, all set for the review on Tuesday at 10.\nx <script',
    })]);
    expect(profile.sampleReplies[0].body).not.toContain('<');
  });
});
