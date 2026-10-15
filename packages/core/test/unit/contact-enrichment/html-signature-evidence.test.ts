import { describe, expect, it } from 'vitest';

import { extractDeterministicProfile } from '../../../src/contact-enrichment/deterministic-profile';
import { extractSignals } from '../../../src/contact-enrichment/signal-extractor';
import { htmlMiningWindow, htmlToPlainText } from '../../../src/utils/html-text';

// This is the exact bounded conversion used by contacts:recentInbound before
// the renderer consumes miningText, including when cleanBody is already long.
const mine = (html: string) => extractSignals(htmlToPlainText(htmlMiningWindow(html, 12 * 1024), { keepLinkHrefs: true }), 'alice@acme.example');
const signature = `<p>Regards,<br>Alice Doe<br>Engineering Lead<br>Acme Ltd<br>
  <a href="mailto:alice@acme.example"><img alt="Email" src="https://cdn.example/email.png"></a><br>
  <a href="tel:+919876543210"><img alt="Phone" src="https://cdn.example/phone.png"></a><br>
  <a href="https://www.linkedin.com/company/acme"><img alt="Company" src="https://cdn.example/company.png"></a>
  <a href="https://www.linkedin.com/in/alice-doe"><img alt="LinkedIn" src="https://cdn.example/linkedin.png"></a>
  <a href="https://www.acme.example"><img alt="Website" src="https://cdn.example/web.png"></a>
  <a href="https://wa.me/919876543210"><img alt="WhatsApp" src="https://cdn.example/whatsapp.png"></a></p>`;
const foreign = `<p>Best,<br>Bob Roe<br>Account Manager<br>bob@vendor.example<br>
  <a href="https://linkedin.com/in/bob-roe"><img alt="LinkedIn"></a>
  <a href="https://vendor.example"><img alt="Website"></a></p>`;

describe('bounded HTML signature evidence transported by recentInbound', () => {
  it('preserves icon-only personal/company/website/WhatsApp links and tel/mailto evidence', () => {
    const signals = mine(`<p>${'The project update is ready. '.repeat(10)}</p>${signature}`);
    const profile = extractDeterministicProfile(signals, 'alice@acme.example');
    expect(profile.fullName).toBe('Alice Doe');
    expect(profile.linkedinUrl).toBe('https://www.linkedin.com/in/alice-doe');
    expect(profile.companyLinkedinUrl).toBe('https://www.linkedin.com/company/acme');
    expect(profile.website).toBe('https://www.acme.example');
    expect(profile.otherSocials).toContainEqual({ platform: 'wa.me', url: 'https://wa.me/919876543210' });
    expect(signals.emails).toContain('alice@acme.example');
    expect(signals.phones).toContain('+919876543210');
    expect(signals.urls.join(' ')).not.toContain('cdn.example');
  });

  it('keeps the current sender above a long quoted chain and excludes quoted icon links', () => {
    const chain = `<p>On Monday, Bob &lt;bob@vendor.example&gt; wrote:</p><blockquote>${'<p>Earlier quoted work.</p>'.repeat(1000)}${foreign}</blockquote>`;
    const signals = mine(`<p>Thanks, update attached.</p>${signature}${chain}`);
    expect(signals.linkedinUrls).toContain('https://www.linkedin.com/in/alice-doe');
    expect(signals.urls.join(' ')).not.toMatch(/bob-roe|vendor\.example/);
  });

  it('does not borrow a forwarded sender\'s links when the current message has no signature', () => {
    const signals = mine(`<p>FYI</p><p>---------- Forwarded message ---------<br>From: Bob &lt;bob@vendor.example&gt;</p>${foreign}`);
    expect(signals.signatureBlock).toBeNull();
    expect(signals.linkedinUrls).toEqual([]);
    expect(signals.websites).toEqual([]);
  });

  it('does not mistake an explicitly addressed colleague signature in an indented HTML quote for the sender', () => {
    const signals = mine(`${signature}<blockquote>${foreign}</blockquote>`);
    expect(signals.urls.join(' ')).not.toMatch(/bob-roe|vendor\.example/);
    expect(signals.linkedinUrls).toContain('https://www.linkedin.com/in/alice-doe');
  });
});
