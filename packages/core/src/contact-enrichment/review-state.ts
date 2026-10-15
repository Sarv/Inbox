import type { ContactEnrichment } from '../types/models';

/** Increment when a change requires one new review of incomplete legacy data. */
export const CONTACT_ENRICHMENT_REVIEW_VERSION = 1;

export interface ContactEnrichmentReview {
  version: number;
  signatureFingerprint?: string;
  throughEmailAt?: number;
}

/** Missing fields are a recovery signal, never a reason to invent profile data. */
export function isIncompleteContactProfile(profile: ContactEnrichment | null | undefined): boolean {
  const hasText = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  return !hasText(profile?.fullName) || !hasText(profile?.designation) || !hasText(profile?.companyName)
    || ![profile?.linkedinUrl, profile?.companyLinkedinUrl, profile?.companyWebsite].some(hasText);
}
