// Hands a pre-filled filter draft from the Advanced Search panel to the Filters
// settings tab. A tiny module-level singleton rather than a CustomEvent so there
// is no mount-timing race: the search panel stashes the draft and navigates to
// Settings → Filters, and FiltersTab consumes it once, on mount.

import type { FilterCondition } from '@sarvinbox/core';

export interface PendingFilterDraft {
  name: string;
  matchType: 'all' | 'any';
  conditions: FilterCondition[];
}

let pending: PendingFilterDraft | null = null;

/** Stash a draft for the Filters tab to pick up when it next mounts. */
export function setPendingFilterDraft(draft: PendingFilterDraft): void {
  pending = draft;
}

/** Read and clear the stashed draft (returns null when there is none). */
export function consumePendingFilterDraft(): PendingFilterDraft | null {
  const draft = pending;
  pending = null;
  return draft;
}
