import { Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useEmailStore } from '../../store/email-store';
import type { AICategoryCounts, AIBoxTab, CategoryDefinition } from '../aibox/types';
import { ICON_MAP, COLOR_MAP } from '../aibox/types';

interface CategoryPill extends AIBoxTab {
  color: string;
}

export function CategoryFilterBar() {
  // Shallow slice-select so the filter bar only re-renders on these fields,
  // not on every unrelated store mutation.
  const {
    viewingAICategory,
    loadAICategoryEmails,
    clearAICategoryView,
    selectFolder,
    selectedFolderId,
    selectedVirtualFolder,
    loadAllEmails,
    loadImportantEmails,
    loadStarredEmails,
    loadSnoozedEmails,
    refreshVirtualFolder,
    viewingSnoozed,
    aiCategoryCountsLastUpdate,
  } = useEmailStore(
    useShallow((s) => ({
      viewingAICategory: s.viewingAICategory,
      loadAICategoryEmails: s.loadAICategoryEmails,
      clearAICategoryView: s.clearAICategoryView,
      selectFolder: s.selectFolder,
      selectedFolderId: s.selectedFolderId,
      selectedVirtualFolder: s.selectedVirtualFolder,
      loadAllEmails: s.loadAllEmails,
      loadImportantEmails: s.loadImportantEmails,
      loadStarredEmails: s.loadStarredEmails,
      loadSnoozedEmails: s.loadSnoozedEmails,
      refreshVirtualFolder: s.refreshVirtualFolder,
      viewingSnoozed: s.viewingSnoozed,
      aiCategoryCountsLastUpdate: s.aiCategoryCountsLastUpdate,
    })),
  );

  const [aiCategoryCounts, setAiCategoryCounts] = useState<AICategoryCounts>({});
  const [categoryTabs, setCategoryTabs] = useState<CategoryPill[]>([]);

  // Load category definitions and build tabs
  useEffect(() => {
    const loadDefs = async () => {
      try {
        const result = await window.electronAPI.ai.getCategoryDefinitions();
        if (result.success && result.data) {
          const enabledDefs = (result.data as CategoryDefinition[]).filter(d => d.isEnabled);
          const tabs: CategoryPill[] = enabledDefs.map(def => ({
            id: def.slug,
            label: def.name,
            icon: ICON_MAP[def.icon] || Tag,
            category: def.slug,
            color: def.color,
          }));
          setCategoryTabs(tabs);
        }
      } catch (error) {
        console.error('Failed to load category definitions:', error);
      }
    };
    loadDefs();
  }, [aiCategoryCountsLastUpdate]);

  // Load AI category counts scoped to the current view. On All Inboxes, sum the
  // counts across every opted-in account so the tab numbers match the unified
  // list; otherwise scope to the active account's selected folder.
  useEffect(() => {
    const loadCounts = async () => {
      try {
        let counts: AICategoryCounts | undefined;
        if (selectedVirtualFolder === 'virtual-unified') {
          const accountIds = useEmailStore
            .getState()
            .accounts.filter((a) => a.includeInUnified !== false)
            .map((a) => a.id);
          const result = await window.electronAPI.accounts.unifiedCategoryCounts(accountIds);
          if (result.success && result.data) counts = result.data as AICategoryCounts;
        } else {
          const result = await window.electronAPI.ai.getCategoryCounts(selectedFolderId ?? undefined);
          if (result.success && result.data) counts = result.data as AICategoryCounts;
        }
        if (counts) setAiCategoryCounts(counts);
      } catch (error) {
        console.error('Failed to load AI category counts:', error);
      }
    };
    loadCounts();
    const interval = setInterval(loadCounts, 30000);
    return () => clearInterval(interval);
  }, [aiCategoryCountsLastUpdate, selectedFolderId, selectedVirtualFolder]);

  // Don't render if no categories defined
  if (categoryTabs.length === 0) {
    return null;
  }

  const handleAllClick = () => {
    // Reload the underlying view BEFORE clearing AI category — view setters
    // guard on viewingAICategory to decide whether a reload is needed. If we
    // clear first, the guard sees null and skips the reload, leaving stale
    // category emails on screen. Handle folder, virtual folder, and snoozed.
    const { searchQuery } = useEmailStore.getState();
    if (!searchQuery) {
      if (selectedFolderId) {
        selectFolder(selectedFolderId);
      } else if (selectedVirtualFolder === 'virtual-unified') {
        refreshVirtualFolder('unified');
      } else if (selectedVirtualFolder === 'virtual-all') {
        loadAllEmails();
      } else if (selectedVirtualFolder === 'virtual-important') {
        loadImportantEmails();
      } else if (selectedVirtualFolder === 'virtual-starred') {
        loadStarredEmails();
      } else if (viewingSnoozed) {
        loadSnoozedEmails();
      }
    }
    clearAICategoryView();
  };

  const handleCategoryClick = (slug: string) => {
    if (viewingAICategory === slug) {
      // Clicking the active pill deselects it
      handleAllClick();
    } else {
      loadAICategoryEmails(slug);
    }
  };

  const isAllActive = !viewingAICategory;

  return (
    <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border bg-muted/20 overflow-x-auto flex-shrink-0">
      {/* "All" pill */}
      <button
        onClick={handleAllClick}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
          isAllActive
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        }`}
      >
        All
      </button>

      {/* Category pills */}
      {categoryTabs.map((tab) => {
        const Icon = tab.icon;
        const count = tab.category ? (aiCategoryCounts[tab.category] || 0) : 0;
        const isActive = viewingAICategory === tab.id;
        const colorSet = COLOR_MAP[tab.color] || COLOR_MAP.blue;

        return (
          <button
            key={tab.id}
            onClick={() => handleCategoryClick(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap border ${
              isActive
                ? `${colorSet.bg} ${colorSet.text} ${colorSet.border}`
                : 'text-muted-foreground hover:text-foreground hover:bg-accent border-transparent'
            }`}
          >
            <Icon className="h-3 w-3" />
            <span>{tab.label}</span>
            {count > 0 && (
              <span className={`px-1.5 py-0.5 text-[10px] rounded-full ${
                isActive ? 'bg-black/10' : 'bg-muted'
              }`}>
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
