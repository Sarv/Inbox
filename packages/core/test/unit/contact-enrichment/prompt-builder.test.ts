import { describe, it, expect } from 'vitest';

import { buildEnrichmentUserMessage, ENRICHMENT_SYSTEM_PROMPT } from '../../../src/contact-enrichment/prompt-builder';
import { extractSignals } from '../../../src/contact-enrichment/signal-extractor';

// The enrichment prompt is what the contact-gathering LLM actually sees. This
// checks the mined SIGNALS (from the real extractor) reach the prompt and that
// the contract instructions ("JSON only") are present — a regression that drops
// signals or the format rule quietly degrades every enrichment.

const BODY = [
  'Thanks,',
  'Alice Roe',
  'Head of Sales, Partner Inc',
  'Mobile: +91 98765 43210',
  'https://www.linkedin.com/in/aliceroe',
].join('\n');

describe('buildEnrichmentUserMessage', () => {
  it('carries the contact identity and the mined signals into the prompt', () => {
    const signals = extractSignals(BODY, 'alice@partner.com');
    const msg = buildEnrichmentUserMessage({
      contactEmail: 'alice@partner.com',
      contactName: 'Alice Roe',
      signals,
      existingOrganization: 'Old Corp',
      existingTitle: 'SDR',
    });

    expect(msg).toContain('email: alice@partner.com');
    expect(msg).toContain('name: Alice Roe');
    expect(msg).toContain('current organization (may be stale): Old Corp');
    expect(msg).toContain('current title (may be stale): SDR');
    expect(msg).toContain('SIGNALS');
    // The extractor found the phone + linkedin → they must appear in the prompt.
    expect(msg).toMatch(/phones:.*98765/);
    expect(msg).toMatch(/linkedin urls:.*aliceroe/i);
    expect(msg).toContain('Return JSON only');
  });

  it('omits optional lines when there is nothing to say (no empty labels)', () => {
    const signals = extractSignals('', 'x@y.com');
    const msg = buildEnrichmentUserMessage({ contactEmail: 'x@y.com', signals });
    expect(msg).toContain('email: x@y.com');
    expect(msg).not.toContain('name:');
    expect(msg).not.toContain('phones:');
    expect(msg).not.toContain('current organization');
  });

  it('system prompt states the JSON-only contract and the free-domain rule', () => {
    expect(ENRICHMENT_SYSTEM_PROMPT).toMatch(/JSON only/i);
    expect(ENRICHMENT_SYSTEM_PROMPT).toMatch(/gmail\.com/i); // free-provider employer rule
  });
});
