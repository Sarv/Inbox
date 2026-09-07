import { useState, useCallback, useEffect } from 'react';

import { useEmailStore } from '../../../store/email-store';

export function useEmailListSearch() {
  const {
    search,
    clearSearch,
    searchQuery,
    activeInboxFilter,
    viewingAICategory,
    aiBoxActiveTab,
    selectedFolderId,
    searchSuggestions,
    fetchSearchSuggestions,
  } = useEmailStore();

  const [localSearchQuery, setLocalSearchQuery] = useState('');

  // Sync local input with store (e.g. when folder switch clears the search)
  useEffect(() => {
    if (!searchQuery) setLocalSearchQuery('');
  }, [searchQuery]);

  // A quick-filter chip (is:unread / is:unlabelled …) narrows the sectioned
  // inbox instead of text-searching — so the raw "is:unread" the chip fired must
  // not linger in the box; the highlighted "Filtered: X" chip shows it instead.
  useEffect(() => {
    if (activeInboxFilter) setLocalSearchQuery('');
  }, [activeInboxFilter]);

  // Debounced search suggestions
  useEffect(() => {
    if (!localSearchQuery || localSearchQuery.length < 2) return;
    const timer = setTimeout(() => {
      // Get the last word for prefix suggestions
      const words = localSearchQuery.trim().split(/\s+/);
      const lastWord = words[words.length - 1];
      if (lastWord && !lastWord.includes(':') && lastWord.length >= 2) {
        fetchSearchSuggestions(lastWord);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [localSearchQuery, fetchSearchSuggestions]);
  const [showAdvancedSearch, setShowAdvancedSearch] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);

  // Build search context based on current view
  const getSearchContext = useCallback(() => {
    const ctx: { folderId?: string; aiCategory?: string } = {};

    if (selectedFolderId) {
      ctx.folderId = selectedFolderId;
    }

    // AI Box tab view (legacy)
    if (viewingAICategory === 'ai-box' && aiBoxActiveTab && aiBoxActiveTab !== 'dashboard') {
      ctx.aiCategory = aiBoxActiveTab;
    } else if (viewingAICategory && viewingAICategory !== 'ai-box') {
      // Category filter bar pill (e.g. "needs_response")
      ctx.aiCategory = viewingAICategory;
    }

    return Object.keys(ctx).length > 0 ? ctx : undefined;
  }, [viewingAICategory, aiBoxActiveTab, selectedFolderId]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (localSearchQuery.trim()) {
      search(localSearchQuery, getSearchContext());
    }
  };

  const handleClearSearch = () => {
    setLocalSearchQuery('');
    clearSearch();
  };

  return {
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
    searchSuggestions,
  };
}
