// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { contactDisplayName, contactProfileCoverage, contactProfileGroups, contactWebUrl } from '../../../../../src/components/contacts/contact-profile';
import { ContactProfile } from '../../../../../src/components/contacts/ContactProfile';
import { cleanup, fire, render } from '../../../../helpers/render';

afterEach(cleanup);

const contact = {
  email: 'alice@acme.example', name: 'Alice McDonald', organization: 'Acme',
  enrichment: {
    fullName: 'Alice McDonald', designation: 'Engineering Lead', department: 'Platform',
    companyName: 'Acme', companyWebsite: 'https://acme.example',
    linkedinUrl: 'https://www.linkedin.com/in/alice-mcdonald',
    companyLinkedinUrl: 'https://www.linkedin.com/company/acme',
    personalPhone: '+14155550123', whatsappNumber: '+1 (415) 555-0123',
    companyPhone: '+12125550123', companyAddress: '123 Example Street, New York',
    otherSocials: [{ platform: 'Instagram', url: 'https://www.instagram.com/alice' }],
  },
};

describe('contact profile information', () => {
  it('preserves saved name spelling and uses signature names over email placeholders', () => {
    expect(contactDisplayName(contact)).toBe('Alice McDonald');
    expect(contactDisplayName({ ...contact, name: 'alice' })).toBe('Alice McDonald');
    expect(contactDisplayName({ ...contact, displayName: 'Dr Alice McDonald' })).toBe('Dr Alice McDonald');
    expect(contactDisplayName({ email: 'alice.smith@example.com' })).toBe('Alice Smith');
  });

  it('separates personal/company links, groups work details and deduplicates WhatsApp phone', () => {
    const groups = contactProfileGroups(contact);
    expect(groups.map((group) => group.label)).toHaveLength(5);
    const fields = groups.flatMap((group) => group.fields);
    expect(fields.find((field) => field.label === 'Designation')?.value).toBe('Engineering Lead');
    expect(fields.find((field) => field.label === 'Company LinkedIn')?.href).toContain('/company/acme');
    expect(fields.find((field) => field.label === 'LinkedIn')?.href).toContain('/in/alice-mcdonald');
    expect(fields.filter((field) => field.value?.includes('415'))).toHaveLength(1);
    expect(fields.find((field) => field.label === 'Mobile / WhatsApp')?.href).toBe('tel:+14155550123');
    expect(contactProfileCoverage(contact)).toMatchObject({ completed: 5, total: 5 });
  });

  // Breaks if a legacy profile (saved before extraction validation) renders a
  // clickable javascript:, data:, vbscript: or file: link, or a link carrying
  // credentials, on the contact card: one click runs or opens whatever was stored.
  it('does not turn legacy unsafe URLs into clickable social links', () => {
    const unsafe = [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'https://user:secret@example.com',
    ];
    for (const url of unsafe) expect(contactWebUrl(url)).toBeUndefined();
    const view = render(<ContactProfile contact={{ ...contact, enrichment: {
      linkedinUrl: unsafe[0], companyLinkedinUrl: unsafe[2], companyWebsite: unsafe[3],
      twitterUrl: unsafe[4], githubUrl: 'https://github.com/alice',
      otherSocials: unsafe.map((url) => ({ platform: 'Other', url })),
    } }} />);
    const hrefs = view.all('a').map((link) => link.getAttribute('href') ?? '');
    // The safe profile still renders, so the scheme check below sees real links.
    expect(hrefs).toContain('https://github.com/alice');
    // An allowlist of schemes, not a list of bad ones: a scheme nobody thought
    // of here fails the test instead of passing it.
    const schemes = hrefs.map((href) => new URL(href, 'https://relative.invalid/').protocol);
    expect(schemes.filter((scheme) => !['https:', 'http:', 'tel:', 'mailto:'].includes(scheme))).toEqual([]);
    expect(hrefs.some((href) => href.includes('secret@'))).toBe(false);
  });

  it('shows profile coverage, missing fields and the email review watermark without inventing details', () => {
    const view = render(<ContactProfile contact={{ email: 'unknown@gmail.com', enrichedThroughEmailAt: 1700000000 }} />);
    expect(view.container.textContent).toContain('1 of 5 profile areas available');
    expect(view.container.textContent).toContain('Not found yet');
    expect(view.container.textContent).toContain('Emails reviewed through');
    expect(view.container.textContent).not.toContain('Gmail at Gmail');
  });

  it('keeps email correspondence navigation and all richer profile details accessible', () => {
    const onSearchMail = vi.fn();
    const view = render(<ContactProfile contact={contact} onSearchMail={onSearchMail} />);
    fire(view.all('button').find((button) => button.textContent === contact.email)!, 'click');
    expect(onSearchMail).toHaveBeenCalledWith(contact.email);
    expect(view.container.textContent).toContain('123 Example Street, New York');
    expect(view.container.textContent).toContain('Platform');
    expect(view.all('a').some((link) => link.textContent === 'https://www.instagram.com/alice')).toBe(true);
  });
});
