import { describe, expect, it } from 'vitest';

import { extractDeterministicProfile } from '../../../src/contact-enrichment/deterministic-profile';
import { extractSignals } from '../../../src/contact-enrichment/signal-extractor';

/**
 * What we can know with NO LLM. These assertions are the floor the contact card
 * should never fall below — they must hold with no AI provider configured.
 */

const profileOf = (body: string, from: string) =>
  extractDeterministicProfile(extractSignals(body, from), from);

describe('extractDeterministicProfile', () => {
  it('recovers name, title and company from a realistic signature', () => {
    const p = profileOf(`Hi team,

Regards!

Pooja Khatri
CBO
+91 9988-776-655
www.sarv.com | +91-9111-9111-00
Jaipur: IT-10, EPIP RIICO Industrial Area, Sitapura, Jaipur 302022`, 'pkh@sarv.com');

    expect(p.fullName).toBe('Pooja Khatri');
    expect(p.title).toMatch(/CBO/);
    expect(p.organization).toBeTruthy();
  });

  it('takes a title that is NOT in the keyword list from the line after the name', () => {
    const p = profileOf(`Thanks,

Arun Iyer
Business Head, West
arun@acme.com`, 'arun@acme.com');
    expect(p.fullName).toBe('Arun Iyer');
    expect(p.title).toBe('Business Head, West');
  });

  it('picks up social profiles', () => {
    const p = profileOf(`Cheers,

Alex Roe
Engineer
https://www.linkedin.com/in/alexroe
https://github.com/alexroe`, 'alex@acme.com');
    expect(p.linkedinUrl).toMatch(/linkedin\.com\/in\/alexroe/);
    expect(p.githubUrl).toMatch(/github\.com\/alexroe/);
  });

  it('never mistakes contact-detail lines for a name', () => {
    const p = profileOf(`Regards,

Tel: +91 98765 43210
support@acme.com
www.acme.com`, 'support@acme.com');
    expect(p.fullName).toBeNull();
  });

  it('does not invent an employer unrelated to the sending domain', () => {
    const p = profileOf(`Regards,

Alex Roe
Engineer
Some Unrelated Phrase`, 'alex@acme.com');
    // Falls back to the domain root rather than grabbing a random line.
    expect(p.organization).toBe('Acme');
  });

  it('returns nulls rather than guesses when there is no signature', () => {
    const p = profileOf('Quick question — are we still on for Friday?', 'x@acme.com');
    expect(p.fullName).toBeNull();
    expect(p.title).toBeNull();
  });

  it('is safe on an empty body', () => {
    const p = profileOf('', 'x@acme.com');
    expect(p.fullName).toBeNull();
  });
});
