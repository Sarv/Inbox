import type { EmailRecord } from '../types/models';

export interface ExistingCategoryClassification {
  source: 'provider' | 'user';
  categories: string[];
}

/** Canonical native provider classifications remain authoritative even before a definition is configured. */
export const GMAIL_NON_AUTHORITATIVE_CATEGORY_SLUGS = ['important', 'social', 'updates', 'forums', 'personal'] as const;

export const NATIVE_PROVIDER_CATEGORY_SLUGS = ['important', 'promotions', 'social', 'updates', 'forums', 'personal'] as const;

/** Unknown native category state is a retry condition, not unclassified mail. */
export function automaticCategorizationDeferred(
  email: Pick<EmailRecord, 'serverCategories' | 'manualCategories' | 'gmailCategoriesPending' | 'gmailImportant'>,
): boolean {
  return email.gmailCategoriesPending === true && !existingCategoryClassification(email);
}

/** Provider/user choices suppress automatic classification, never ordinary mailbox flags. */
export function existingCategoryClassification(
  email: Pick<EmailRecord, 'serverCategories' | 'manualCategories' | 'gmailImportant'>,
): ExistingCategoryClassification | null {
  if (Array.isArray(email.manualCategories)) {
    return { source: 'user', categories: [...email.manualCategories] };
  }
  const categories = providerCategorySelection(email.serverCategories, email.gmailImportant);
  if (categories.length > 0) return { source: 'provider', categories };
  return null;
}

/** Gmail's native tabs/Important are independent hints; only Promotions and custom labels own categories. */
export function providerCategorySelection(categories: readonly string[] | null | undefined, gmailImportant?: boolean | null): string[] {
  return [...(categories ?? [])].filter((slug) => typeof gmailImportant !== 'boolean' ||
    !(GMAIL_NON_AUTHORITATIVE_CATEGORY_SLUGS as readonly string[]).includes(slug));
}

/** A manual marker owns both on/off; a positive native marker survives an AI classification. */
export function independentImportance(email: Pick<EmailRecord, 'gmailImportant' | 'manualImportant'>): boolean | null {
  if (typeof email.manualImportant === 'boolean') return email.manualImportant;
  return email.gmailImportant === true ? true : null;
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
