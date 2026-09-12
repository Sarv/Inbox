import { describe, it, expect } from 'vitest';

import { contactPhoneView, formatPhone } from '../../../../src/components/contact-phone-view';

describe('formatPhone', () => {
  // Regression: senders type their number in whatever shape they like
  // ("+91-9111911100", "+919111911100"). Without normalising, the contact list
  // reads as a column of mismatched strings.
  it('renders a valid number in one international shape', () => {
    expect(formatPhone('+919111911100')).toBe('+91 91119 11100');
    expect(formatPhone('+91-9111911100')).toBe('+91 91119 11100');
  });

  // Regression: an unparseable value must still be SHOWN. Returning '' here
  // would silently hide a number the user can read perfectly well.
  it('shows an unparseable value as the sender typed it', () => {
    expect(formatPhone('reception, ext 4')).toBe('reception, ext 4');
  });

  it('treats a missing number as nothing to render', () => {
    expect(formatPhone(null)).toBe('');
    expect(formatPhone(undefined)).toBe('');
    expect(formatPhone('')).toBe('');
  });
});

describe('contactPhoneView', () => {
  // Regression: the whole point of the phone classifier is that a person's own
  // mobile outranks the switchboard everyone in their company shares. If this
  // order flips, every colleague shows the same number.
  it('prefers the classified personal number over the company line', () => {
    expect(contactPhoneView({
      enrichment: { personalPhone: '+919782795905', companyPhone: '+919111911100' },
      phone: '+919111911100',
    })).toEqual({ number: '+91 97827 95905', isOffice: false });
  });

  // Regression: with no personal number we fall back to the office line, and it
  // MUST be labelled — an unlabelled switchboard next to a person's name reads
  // as their own number.
  it('falls back to the company line and says that it is one', () => {
    expect(contactPhoneView({
      enrichment: { companyPhone: '+919111911100' },
    })).toEqual({ number: '+91 91119 11100', isOffice: true });
  });

  // Regression: WhatsApp and the identity-level mobile are personal numbers
  // too, and must not be demoted to "(office)".
  it('counts WhatsApp and mobileE164 as personal', () => {
    expect(contactPhoneView({ enrichment: { whatsappNumber: '+919782795905' } }))
      .toEqual({ number: '+91 97827 95905', isOffice: false });
    expect(contactPhoneView({ mobileE164: '+919782795905' }))
      .toEqual({ number: '+91 97827 95905', isOffice: false });
  });

  // Regression: `phone` is scraped from signatures and often IS the toll-free
  // line, so it ranks last — and, being unclassified, is labelled as office
  // rather than passed off as the contact's own number.
  it('uses the raw scraped column only as a last resort', () => {
    expect(contactPhoneView({ phone: '+911800123456' }))
      .toEqual({ number: '+91 1800 12 3456', isOffice: true });
    // A company line still outranks it.
    expect(contactPhoneView({ enrichment: { companyPhone: '+919111911100' }, phone: '+911800123456' }))
      .toEqual({ number: '+91 91119 11100', isOffice: true });
  });

  // Regression: a contact with no number at all must render NOTHING, not an
  // empty phone row with a dangling icon.
  it('returns null when there is no number anywhere', () => {
    expect(contactPhoneView({})).toBeNull();
    expect(contactPhoneView({ enrichment: null, mobileE164: null, phone: null })).toBeNull();
    expect(contactPhoneView({ enrichment: { personalPhone: '', companyPhone: '' }, phone: '' })).toBeNull();
  });

  // Regression: mining writes null into personalPhone/companyPhone when it
  // finds nothing (the classifier owns those fields), so the null case is the
  // COMMON one, not an edge case.
  it('skips explicitly nulled classifications and keeps looking', () => {
    expect(contactPhoneView({
      enrichment: { personalPhone: null, companyPhone: null },
      phone: '+919782795905',
    })).toEqual({ number: '+91 97827 95905', isOffice: true });
  });
});
