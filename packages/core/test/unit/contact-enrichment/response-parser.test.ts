import { describe, it, expect } from 'vitest';

import { parseEnrichmentResponse } from '../../../src/contact-enrichment/response-parser';

// The parser turns the contact-enrichment LLM's reply into a validated blob.
// A regression here means contact details silently go missing or the whole
// enrichment run crashes on one bad reply — so it must tolerate the LLM's usual
// mistakes (fences, <think> blocks, prose) and NEVER throw.

const FULL = JSON.stringify({
  fullName: 'Alice Roe', designation: 'Head of Sales', department: 'Revenue',
  companyName: 'Partner Inc', companyDomain: 'PARTNER.COM', companyWebsite: 'partner.com',
  companyAddress: '1 Market St', linkedinUrl: 'linkedin.com/in/aliceroe',
  twitterUrl: 'https://twitter.com/aliceroe', githubUrl: null,
  personalPhone: '+1 415 555 2671', companyPhone: '+1 415 555 0000', whatsappNumber: null,
  personalEmail: 'Alice@Gmail.com', location: 'SF', pronouns: 'she/her',
  otherSocials: [{ platform: 'mastodon', url: 'mas.to/@alice' }],
  notes: 'Prefers email',
});

describe('parseEnrichmentResponse', () => {
  it('parses a full object and normalizes domain/email/URLs', () => {
    const e = parseEnrichmentResponse(FULL)!;
    expect(e.fullName).toBe('Alice Roe');
    expect(e.designation).toBe('Head of Sales');
    expect(e.companyDomain).toBe('partner.com');          // lowercased
    expect(e.companyWebsite).toBe('https://partner.com');  // bare domain → https
    expect(e.linkedinUrl).toBe('https://linkedin.com/in/aliceroe');
    expect(e.twitterUrl).toBe('https://twitter.com/aliceroe'); // already a URL, kept
    expect(e.personalEmail).toBe('alice@gmail.com');       // lowercased
    expect(e.otherSocials).toEqual([{ platform: 'mastodon', url: 'https://mas.to/@alice' }]);
  });

  it('strips markdown code fences the model adds despite instructions', () => {
    const e = parseEnrichmentResponse('```json\n{"fullName":"Bob"}\n```')!;
    expect(e.fullName).toBe('Bob');
  });

  it('strips a <think> block from a reasoning model', () => {
    const e = parseEnrichmentResponse('<think>the domain is partner.com so…</think>\n{"companyName":"Partner Inc"}')!;
    expect(e.companyName).toBe('Partner Inc');
  });

  it('isolates the object from surrounding prose', () => {
    const e = parseEnrichmentResponse('Here is the contact:\n{"fullName":"Cara"}\nHope that helps!')!;
    expect(e.fullName).toBe('Cara');
  });

  it('coerces missing/empty/null fields to null (not undefined or "")', () => {
    const e = parseEnrichmentResponse('{"fullName":"","designation":null}')!;
    expect(e.fullName).toBeNull();
    expect(e.designation).toBeNull();
    expect(e.githubUrl).toBeNull();
    expect(e.otherSocials).toEqual([]);
  });

  it('returns null (never throws) for garbage, empty, or invalid-JSON input', () => {
    expect(parseEnrichmentResponse('')).toBeNull();
    expect(parseEnrichmentResponse('   ')).toBeNull();
    expect(parseEnrichmentResponse('not json at all')).toBeNull();
    expect(() => parseEnrichmentResponse('{ broken')).not.toThrow();
    expect(parseEnrichmentResponse('{ broken')).toBeNull();
  });

  it('drops malformed otherSocials entries (missing platform or url)', () => {
    const e = parseEnrichmentResponse('{"otherSocials":[{"platform":"x"},{"url":"y.com"},{"platform":"m","url":"m.social"}]}')!;
    expect(e.otherSocials).toEqual([{ platform: 'm', url: 'https://m.social' }]);
  });
});
