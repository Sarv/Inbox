// Which of a contact's numbers to show, and how to write it. Pure, so the rule
// is tested without rendering a contact — and shared, so the list row and the
// detail card can never disagree about which number belongs to a person.

import { parsePhoneNumberFromString } from 'libphonenumber-js';

/** The phone-bearing fields of a contact, as the renderer sees them. */
export interface PhoneBearingContact {
  enrichment?: {
    personalPhone?: string | null;
    companyPhone?: string | null;
    whatsappNumber?: string | null;
  } | null;
  mobileE164?: string | null;
  phone?: string | null;
}

export interface ContactPhoneView {
  /** Formatted for display, e.g. "+91 88990 01122". */
  number: string;
  /**
   * True when the only number we have is the shared company line. The caller
   * must say so — an office switchboard printed next to a person's name reads
   * as their own number, and on a list of colleagues it is the SAME number
   * repeated down the page.
   */
  isOffice: boolean;
}

/**
 * Render any phone number in one consistent international format
 * ("+91 88990 01122") via libphonenumber-js, so a contact's office/direct
 * numbers don't show up in the mismatched shapes senders type. Falls back to
 * the original string when the value can't be parsed as a phone number.
 *
 * KNOWN LIMITATION: the default region is hardcoded to India, here and in the
 * extractor (`DEFAULT_PHONE_REGION` in signal-extractor.ts). A national-format
 * number from another country round-trips unformatted rather than wrongly —
 * `isValid()` rejects it and we show what the sender typed.
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const parsed = parsePhoneNumberFromString(raw, 'IN');
    if (parsed && parsed.isValid()) return parsed.formatInternational();
  } catch { /* not a parseable number — show as-is */ }
  return raw;
}

/**
 * The one number to put next to a contact's name, or null when we have none.
 *
 * Order: the classified personal/mobile number first, then WhatsApp, then the
 * identity-level `mobileE164`, then the company line, and only last the raw
 * `phone` column — which is populated by signature scraping and frequently
 * lands on the office or toll-free line, so it is misleading unless nothing
 * better exists.
 */
export function contactPhoneView(contact: PhoneBearingContact): ContactPhoneView | null {
  const personal =
    contact.enrichment?.personalPhone ||
    contact.enrichment?.whatsappNumber ||
    contact.mobileE164 ||
    null;
  const office = contact.enrichment?.companyPhone || null;
  const display = personal || office || contact.phone || null;
  if (!display) return null;
  return { number: formatPhone(display), isOffice: !personal };
}
