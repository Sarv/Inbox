// Email store - Zustand state management (slim combiner)
// Each slice lives in ./slices/ and manages a focused domain.

import { create } from 'zustand';

import { loadSavedViewMode, loadInboxSettings, saveViewMode, setupAICategorizationListeners } from './helpers';
import { createComposeSlice } from './slices/compose-slice';
import { createConnectionSlice } from './slices/connection-slice';
import { createEmailActionsSlice } from './slices/email-actions-slice';
import { createEmailsSlice } from './slices/emails-slice';
import { createSearchAISlice } from './slices/search-ai-slice';
import { createSyncSlice } from './slices/sync-slice';
import type { EmailStore } from './types';

export const useEmailStore = create<EmailStore>()((...a) => ({
  ...createConnectionSlice(...a),
  ...createSyncSlice(...a),
  ...createEmailsSlice(...a),
  ...createEmailActionsSlice(...a),
  ...createSearchAISlice(...a),
  ...createComposeSlice(...a),

  // UI slice (small enough to inline)
  viewMode: loadSavedViewMode(),
  ...loadInboxSettings(),

  setViewMode: (mode) => {
    a[0]({ viewMode: mode });
    saveViewMode(mode);
  },

  reloadInboxSettings: () => {
    const set = a[0];
    const get = a[1];
    // Apply the new inbox type / sections first.
    set(loadInboxSettings());

    // Section IDs ('section-1', 'section-2', …) are reused across inbox types
    // but their filter meaning changes (e.g. section-1 is 'important' under
    // important_first but 'unread' under unread_first). The cached sectionData
    // — and its stale per-section totals/pagination — would otherwise be
    // rendered against the new filters, making threads vanish. So drop it and
    // re-run whichever view is currently active with the fresh settings.
    const {
      selectedFolderId,
      selectedVirtualFolder,
      viewingSnoozed,
      viewingAICategory,
      searchQuery,
      folders,
      inboxType,
      inboxSections,
    } = get();

    // Curated/flat views don't use inbox-type sections — nothing to reload.
    if (viewingSnoozed || viewingAICategory || searchQuery) return;

    set({ sectionData: {}, sectionLoading: new Set() });

    if (selectedVirtualFolder === 'virtual-all') {
      get().loadAllEmails();
      return;
    }
    if (selectedVirtualFolder) return; // starred/important virtual folders are flat

    const folder = folders.find((f) => f.id === selectedFolderId);
    const isInbox = folder?.path === 'INBOX';
    if (isInbox && inboxType !== 'default' && inboxSections.length > 0) {
      get().loadAllSections(folder?.path);
    } else if (selectedFolderId) {
      get().loadEmails(selectedFolderId);
    }
  },
}));

// Set up AI categorization IPC event listeners (once at module load)
setupAICategorizationListeners(useEmailStore);

// Re-export types for backward compatibility
export type { ComposeMode, ComposeState, ConnectionStatus, ViewMode, AIProcessingProgress } from './types';
