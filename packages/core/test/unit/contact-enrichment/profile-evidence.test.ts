import { afterEach, describe, expect, it } from 'vitest';

import { contactLinkKind, normalizeContactUrl } from '../../../src/contact-enrichment/contact-links';
import { extractDeterministicProfile } from '../../../src/contact-enrichment/deterministic-profile';
import { buildEnrichmentUserMessage } from '../../../src/contact-enrichment/prompt-builder';
import { parseEnrichmentResponse } from '../../../src/contact-enrichment/response-parser';
import { extractSignals, setExtractorSignatureSplitter } from '../../../src/contact-enrichment/signal-extractor';

const FROM = 'elodie@acme.example';
const SIGNATURE = `Thanks & Regards,
Élodie Martin
Senior Engineer
Department: Engineering
Acme Technologies Ltd
Address: 10 Market Street, Suite 2
Paris 75001
Mobile: +33 6 12 34 56 78
Email: ${FROM}
Personal: elodie.personal@gmail.com
Pronouns: she/her
Website: www.acme.example
https://www.linkedin.com/company/acme?trk=email
https://fr.linkedin.com/in/elodie-martin?utm_source=signature
https://www.x.com/elodie
https://github.com/elodie
https://instagram.com/elodie
https://www.linkedin.com/sharing/share-offsite/?url=https://news.example
https://twitter.com/intent/tweet?text=share
https://github.com/elodie/some-repository
https://click.marketing.example/track?id=123`;

afterEach(() => setExtractorSignatureSplitter(null));

describe('sender-owned signature profile evidence', () => {
  it('extracts rich explicit identity/work/contact fields and separates personal/company profiles', () => {
    const signals = extractSignals(`Please read https://news.example/article/123 first.\n\n${SIGNATURE}`, FROM);
    const profile = extractDeterministicProfile(signals, FROM);
    expect(profile).toMatchObject({
      fullName: 'Élodie Martin', title: 'Senior Engineer', department: 'Engineering',
      organization: 'Acme Technologies Ltd', website: 'https://www.acme.example',
      companyAddress: '10 Market Street, Suite 2\nParis 75001',
      linkedinUrl: 'https://fr.linkedin.com/in/elodie-martin',
      companyLinkedinUrl: 'https://www.linkedin.com/company/acme',
      twitterUrl: 'https://www.x.com/elodie', githubUrl: 'https://github.com/elodie',
      pronouns: 'she/her', personalEmail: 'elodie.personal@gmail.com',
      otherSocials: [{ platform: 'instagram.com', url: 'https://instagram.com/elodie' }],
    });
    expect(signals.urls.join(' ')).not.toMatch(/news\.example|share-offsite|intent|some-repository|marketing\.example/);
    const prompt = buildEnrichmentUserMessage({ contactEmail: FROM, signals });
    expect(prompt).toContain('linkedin urls: https://fr.linkedin.com/in/elodie-martin');
    expect(prompt).toContain('company linkedin urls: https://www.linkedin.com/company/acme');
  });

  it('does not derive an employer or website from a personal mailbox domain', () => {
    const profile = extractDeterministicProfile(extractSignals('Regards,\nAlice Roe\nSales Manager', 'alice@gmail.com'), 'alice@gmail.com');
    expect(profile.fullName).toBe('Alice Roe');
    expect(profile.title).toBe('Sales Manager');
    expect(profile.organization).toBeNull();
    expect(profile.website).toBeNull();
  });

  it('accepts explicit legal company names even for a public mailbox and never treats a title as a name', () => {
    const profile = extractDeterministicProfile(extractSignals('Regards,\nSales Manager\nAcme Ltd\nacme.example', 'sales@gmail.com'), 'sales@gmail.com');
    expect(profile.fullName).toBeNull();
    expect(profile.organization).toBe('Acme Ltd');
    expect(profile.website).toBe('https://acme.example');
  });

  it('does not promote ordinary body links or someone else\'s forwarded signature to profile fields', () => {
    const body = `FYI https://news.example/story\n\n---------- Forwarded message ---------\nFrom: Élodie Martin <${FROM}>\n\n${SIGNATURE}`;
    const signals = extractSignals(body, 'bob@acme.example');
    expect(signals.signatureBlock).toBeNull();
    expect(signals.urls).toEqual([]);
    const profile = extractDeterministicProfile(signals, 'bob@acme.example');
    expect(profile.fullName).toBeNull();
    expect(profile.companyLinkedinUrl).toBeNull();
  });

  it('checks each parser fragment rather than allowing one self-address to bless a colleague signature', () => {
    const own = `Regards,\nÉlodie Martin\nEngineer\n${FROM}\nhttps://linkedin.com/in/elodie`;
    const foreign = 'Regards,\nBob Roe\nManager\nbob@acme.example\nhttps://linkedin.com/in/bob';
    setExtractorSignatureSplitter(() => [own, foreign]);
    const signals = extractSignals(`${own}\n\nOn Monday Bob <bob@acme.example> wrote:\n${foreign}`, FROM);
    expect(signals.signatureBlock).toBe(own);
    expect(signals.linkedinUrls).toEqual(['https://linkedin.com/in/elodie']);
    expect(extractDeterministicProfile(signals, FROM).fullName).toBe('Élodie Martin');
  });

  it('can identify an un-delimited contact block when it explicitly names the sender', () => {
    const signals = extractSignals(`Please review.\n\nÉlodie Martin\nEngineer\n${FROM}\nwww.acme.example`, FROM);
    expect(extractDeterministicProfile(signals, FROM).fullName).toBe('Élodie Martin');
    expect(signals.websites).toEqual(['https://www.acme.example']);
  });
});

describe('contact URL destinations', () => {
  it.each([
    ['javascript:alert(1)', null], ['https://linkedin.com.evil.example/in/alice', 'website'],
    ['https://linkedin.com/sharing/share-offsite/?url=x', null], ['https://www.twitter.com/intent/tweet', null],
    ['https://github.com/alice/repository', null], ['https://youtube.com/watch?v=123', null],
    ['https://instagram.com/p/abc', null], ['https://x.com/alice/status/123', null],
    ['https://linkedin.com/company/acme?trk=signature', 'linkedinCompany'],
    ['https://in.linkedin.com/in/alice', 'linkedinPersonal'],
    ['https://youtube.com/@alice', 'other'],
  ])('classifies %s without confusing links with personal profiles', (url, kind) => {
    expect(contactLinkKind(url)).toBe(kind);
  });

  it('unwraps an explicit Outlook safe link without network requests', () => {
    const destination = 'https://linkedin.com/in/alice?trk=email';
    const wrapped = `https://nam01.safelinks.protection.outlook.com/?url=${encodeURIComponent(destination)}&data=tracking`;
    expect(normalizeContactUrl(wrapped)).toBe('https://linkedin.com/in/alice');
  });
});

describe('LLM enrichment evidence validation', () => {
  it('keeps observed fields while dropping invented people, titles, phones and links', () => {
    const signals = extractSignals(SIGNATURE, FROM);
    const result = parseEnrichmentResponse(JSON.stringify({
      fullName: 'Élodie Martin', designation: 'Chief Executive Officer', department: 'Engineering',
      companyName: 'Invented Employer', companyDomain: 'acme.example', companyWebsite: 'https://www.acme.example',
      companyAddress: '10 Market Street, Suite 2\nParis 75001', linkedinUrl: 'https://fr.linkedin.com/in/elodie-martin',
      companyLinkedinUrl: 'https://www.linkedin.com/company/acme', githubUrl: 'https://github.com/invented',
      personalPhone: '+33 6 12 34 56 78', companyPhone: '+1 415 555 0199',
      otherSocials: [{ platform: 'instagram', url: 'https://instagram.com/elodie' }, { platform: 'x', url: 'https://x.com/invented' }],
      pronouns: 'she/her', personalEmail: 'elodie.personal@gmail.com',
    }), signals)!;
    expect(result.fullName).toBe('Élodie Martin');
    expect(result.designation).toBeNull();
    expect(result.companyName).toBeNull();
    expect(result.companyDomain).toBe('acme.example');
    expect(result.companyWebsite).toBe('https://www.acme.example');
    expect(result.companyLinkedinUrl).toBe('https://www.linkedin.com/company/acme');
    expect(result.githubUrl).toBeNull();
    expect(result.personalPhone).toBe('+33 6 12 34 56 78');
    expect(result.companyPhone).toBeNull();
    expect(result.otherSocials).toHaveLength(1);
  });

  it('never accepts a company LinkedIn page as a personal profile or a non-HTTP URL', () => {
    const result = parseEnrichmentResponse(JSON.stringify({ linkedinUrl: 'https://linkedin.com/company/acme', companyWebsite: 'javascript:alert(1)', twitterUrl: 'https://linkedin.com/in/alice' }))!;
    expect(result.linkedinUrl).toBeNull();
    expect(result.companyLinkedinUrl).toBe('https://linkedin.com/company/acme');
    expect(result.companyWebsite).toBeNull();
    expect(result.twitterUrl).toBeNull();
  });
});
