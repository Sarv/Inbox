import type { ContactEnrichment } from '@sarvinbox/core';

import { formatPhone } from '../contact-phone-view';

export interface ContactProfileSource {
  email: string;
  name?: string | null;
  displayName?: string | null;
  title?: string | null;
  organization?: string | null;
  phone?: string | null;
  mobileE164?: string | null;
  enrichment?: ContactEnrichment | null;
}

export interface ProfileField {
  label: string;
  value: string | null;
  href?: string;
}

export interface ProfileGroup {
  label: string;
  fields: ProfileField[];
}

/** Preserve a person's spelling; only humanize an email-local-part fallback. */
export function contactDisplayName(contact: ContactProfileSource): string {
  const local = contact.email.split('@')[0] || contact.email;
  const storedName = contact.displayName?.trim() || contact.name?.trim();
  if (storedName && storedName.toLowerCase() !== local.toLowerCase()
    && storedName.toLowerCase() !== contact.email.toLowerCase()) return storedName;
  if (contact.enrichment?.fullName?.trim()) return contact.enrichment.fullName.trim();
  return local.replace(/[._-]+/g, ' ').replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

/** Legacy profiles can predate extraction validation. Never make an unsafe link. */
export function contactWebUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function contactProfileGroups(contact: ContactProfileSource): ProfileGroup[] {
  const enrichment = contact.enrichment;
  const phone = (label: string, value?: string | null): ProfileField => ({
    label, value: value ? formatPhone(value) : null,
    ...(value && /^\+?[\d\s().-]+$/.test(value) ? { href: `tel:${value.replace(/[^+\d]/g, '')}` } : {}),
  });
  const web = (label: string, value?: string | null): ProfileField => {
    const href = contactWebUrl(value);
    return { label, value: href ? value! : null, ...(href ? { href } : {}) };
  };
  const mobile = enrichment?.personalPhone || contact.mobileE164;
  const office = enrichment?.companyPhone;
  const fallbackPhone = !mobile && !office ? contact.phone : null;
  const sameNumber = (a?: string | null, b?: string | null) =>
    !!a && !!b && a.replace(/\D/g, '') === b.replace(/\D/g, '');
  const whatsAppIsMobile = sameNumber(mobile, enrichment?.whatsappNumber);
  const personalEmail = enrichment?.personalEmail?.toLowerCase() !== contact.email.toLowerCase()
    ? enrichment?.personalEmail : null;
  const online = [
    web('LinkedIn', enrichment?.linkedinUrl),
    web('Company LinkedIn', enrichment?.companyLinkedinUrl),
    web('Website', enrichment?.companyWebsite),
    web('X / Twitter', enrichment?.twitterUrl),
    web('GitHub', enrichment?.githubUrl),
  ];
  const knownUrls = new Set(online.map((field) => field.href).filter(Boolean));
  for (const social of enrichment?.otherSocials ?? []) {
    const field = web(social.platform || 'Social profile', social.url);
    if (field.href && !knownUrls.has(field.href)) {
      online.push(field);
      knownUrls.add(field.href);
    }
  }
  return [
    { label: 'Basic information', fields: [
      { label: 'Name', value: contactDisplayName(contact) },
      { label: 'Email', value: contact.email },
      ...(enrichment?.pronouns ? [{ label: 'Pronouns', value: enrichment.pronouns }] : []),
    ] },
    { label: 'Work', fields: [
      { label: 'Designation', value: enrichment?.designation || contact.title || null },
      { label: 'Department', value: enrichment?.department || null },
      { label: 'Company', value: enrichment?.companyName || contact.organization || null },
      ...(enrichment?.companyDomain ? [{ label: 'Company domain', value: enrichment.companyDomain }] : []),
    ] },
    { label: 'Phone & other email', fields: [
      phone(whatsAppIsMobile ? 'Mobile / WhatsApp' : fallbackPhone ? 'Phone' : 'Mobile / direct', mobile || fallbackPhone),
      phone('Office', office),
      ...(!whatsAppIsMobile && enrichment?.whatsappNumber ? [phone('WhatsApp', enrichment.whatsappNumber)] : []),
      ...(personalEmail ? [{ label: 'Other email', value: personalEmail }] : []),
    ] },
    { label: 'Online profiles', fields: online },
    { label: 'Location', fields: [
      { label: 'Location', value: enrichment?.location || null },
      { label: 'Company address', value: enrichment?.companyAddress || null },
    ] },
  ];
}

export function contactProfileCoverage(contact: ContactProfileSource) {
  const groups = contactProfileGroups(contact);
  return {
    completed: groups.filter((group) => group.fields.some((field) => field.value)).length,
    total: groups.length,
    details: groups.flatMap((group) => group.fields).filter((field) => field.value).length,
  };
}
