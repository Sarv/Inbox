import type { EmailRecord } from '../types/models';

export interface ExistingCategoryClassification {
  source: 'provider' | 'user';
  categories: string[];
}

/** Canonical native provider classifications remain authoritative even before a definition is configured. */
export const NATIVE_PROVIDER_CATEGORY_SLUGS = ['important', 'promotions', 'social', 'updates', 'forums', 'personal'] as const;

/** Unknown native category state is a retry condition, not unclassified mail. */
export function automaticCategorizationDeferred(
  email: Pick<EmailRecord, 'serverCategories' | 'manualCategories' | 'gmailCategoriesPending'>,
): boolean {
  return email.gmailCategoriesPending === true && !existingCategoryClassification(email);
}

/** Provider/user choices suppress automatic classification, never ordinary mailbox flags. */
export function existingCategoryClassification(
  email: Pick<EmailRecord, 'serverCategories' | 'manualCategories'>,
): ExistingCategoryClassification | null {
  if (Array.isArray(email.manualCategories)) {
    return { source: 'user', categories: [...email.manualCategories] };
  }
  if (Array.isArray(email.serverCategories) && email.serverCategories.length > 0) {
    return { source: 'provider', categories: [...email.serverCategories] };
  }
  return null;
}

/** Storage boundary parser: malformed metadata never invents a classification. */
export function parseCategorySelection(raw: unknown): string[] | null {
  if (raw == null) return null;
  try {
    const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? [...new Set(value as string[])] : null;
  } catch { return null; }
}
