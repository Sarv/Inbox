import type { EmailRecord } from '@sarvinbox/core';
import { Loader2 } from 'lucide-react';
import { useState, useEffect } from 'react';

import { useEmailStore } from '../../store/email-store';
import { buildThreads } from '../../utils/thread-utils';
import { useEmailListSearch } from '../email-list/hooks/useEmailListSearch';
import type { AIBoxCategoryViewProps } from '../email-list/types';
import { SearchBar } from '../SearchBar';

import { buildTabLabels } from './types';
import type { CategoryDefinition } from './types';


export function AIBoxCategoryView({
  renderThread,
}: Pick<AIBoxCategoryViewProps, 'renderThread'>) {
  const {
    searchResults,
    searching,
    viewingAICategory,
    viewMode,
    setEmails,
    aiCategoryCountsLastUpdate,
  } = useEmailStore();

  const {
    localSearchQuery,
    setLocalSearchQuery,
    showAdvancedSearch,
    setShowAdvancedSearch,
    searchFocused,
    setSearchFocused,
    getSearchContext,
    handleSearch,
    handleClearSearch,
    search,
    searchQuery,
  } = useEmailListSearch();

  const [aiCategoryEmails, setAiCategoryEmails] = useState<EmailRecord[]>([]);
  const [loadingAICategoryEmails, setLoadingAICategoryEmails] = useState(false);
  const [tabLabels, setTabLabels] = useState<Record<string, string>>({ dashboard: 'Dashboard' });

  // Load tab labels from category definitions
  useEffect(() => {
    const loadLabels = async () => {
      try {
        const result = await window.electronAPI.ai.getCategoryDefinitions();
        if (result.success && result.data) {
          setTabLabels(buildTabLabels(result.data as CategoryDefinition[]));
        }
      } catch (error) {
        console.error('Failed to load category definitions:', error);
      }
    };
    loadLabels();
  }, []);

  // Load AI category emails when viewing a category
  useEffect(() => {
    if (viewingAICategory && viewingAICategory !== 'ai-box') {
      const loadCategoryEmails = async () => {
        setLoadingAICategoryEmails(true);
        try {
          const result = await window.electronAPI.ai.getByCategory(viewingAICategory, 100, 0);
          if (result.success && result.data) {
            setAiCategoryEmails(result.data);
            setEmails(result.data);
          }
        } catch (error) {
          console.error('Failed to load AI category emails:', error);
        } finally {
          setLoadingAICategoryEmails(false);
        }
      };
      loadCategoryEmails();
    } else {
      setAiCategoryEmails([]);
    }
    // Re-fetch when a live categorization lands (aiCategoryCountsLastUpdate is
    // bumped by the pipeline listener) so this list adds/removes members without
    // a tab switch.
  }, [viewingAICategory, setEmails, aiCategoryCountsLastUpdate]);

  return (
    <>
      {/* Search Bar */}
      <SearchBar
        placeholder={`Search ${(viewingAICategory && tabLabels[viewingAICategory]) || 'emails'}...`}
        localSearchQuery={localSearchQuery}
        setLocalSearchQuery={setLocalSearchQuery}
        onSearch={handleSearch}
        onClear={handleClearSearch}
        showClearButton={!!(localSearchQuery || searchQuery)}
        searchFocused={searchFocused}
        setSearchFocused={setSearchFocused}
        showAdvancedSearch={showAdvancedSearch}
        setShowAdvancedSearch={setShowAdvancedSearch}
        getSearchContext={getSearchContext}
        search={search}
        viewMode={viewMode}
        initialQuery={localSearchQuery}
      />

      {/* Email list for AI category */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        {loadingAICategoryEmails || searching ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (searchQuery ? searchResults : aiCategoryEmails).length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            {searchQuery ? `No results for "${searchQuery}"` : `No emails in ${(viewingAICategory && tabLabels[viewingAICategory]) || 'this category'}`}
          </div>
        ) : (
          <div>
            {searchQuery && (
              <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border">
                {searchResults.length} results for "{searchQuery}" in {(viewingAICategory && tabLabels[viewingAICategory]) || 'this category'}
              </div>
            )}
            {(() => {
              const emailsToRender = searchQuery ? searchResults : aiCategoryEmails;
              const aiThreads = buildThreads(emailsToRender);

              return aiThreads.map((thread) => renderThread(thread));
            })()}
          </div>
        )}
      </div>
    </>
  );
}
