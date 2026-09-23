import { shouldAutoEscalateToServer, describeServerSearchResult, hasServerSearchableParsedQuery, needsFullQuerySearch } from '../../components/server-search';
import { INBOX_QUICK_FILTERS } from '../../config/search-suggestions';
import { isSignatureDetectionEnabled, detectSignature, isCategorizationEnabled, getDefaultProvider, getAIHealth, parseSearchQuery, isAISearchEnabled } from '../../services/ai-service';
import { isAutoChatExtractEnabled, isConversationModeEnabled, extractConversation } from '../../services/conversation-service';
import { getMaxAIProcessingEmails, getEmailsPerPage, getPageSizeForView, SECTION_FULL_PAGE_SIZE, fetchAICategoryTotal } from '../helpers';
import type { SearchAISlice, SliceCreator } from '../types';

// Re-entry guard for autoExtractRecentConversations — every IDLE 'new' event
// fires a pass, and overlapping passes would extract the same threads twice.
let autoExtractRunning = false;

// The parsed query + context of the ACTIVE search, kept so goToSearchPage can
// re-fetch any page without re-parsing (and without threading them through the
// UI). Module-scoped like autoExtractRunning — there is a single store instance.
let activeSearchParsed: any = null;
let activeSearchContext: { folderId?: string; aiCategory?: string } | null = null;

export const createSearchAISlice: SliceCreator<SearchAISlice> = (set, get) => ({
  searchQuery: '',
  searchResults: [],
  searching: false,
  searchInterpretation: null,
  searchSuggestions: [],
  searchFilter: null,
  // Discrete pagination for search results (same pattern as the folder list):
  // one page of getEmailsPerPage() rows at a time, so a filter matching 3k mails
  // pages through all of them instead of truncating at a cap.
  searchPage: 0,
  searchHasMore: false,
  // True total of ALL matches across the whole mailbox (a COUNT, not the loaded
  // page) — the paginator's "of N". 0 = unknown (e.g. All Inboxes), where
  // prev/next falls back to searchHasMore.
  searchTotal: 0,
  searchingServer: false,
  serverSearchRan: false,
  serverSearchStatus: null,

  activeInboxFilter: null,
  activeInboxFilterLabel: null,

  viewingAICategory: null,
  viewingSection: null,
  viewingSectionLabel: null,
  viewingSectionPageSize: 25,
  aiBoxActiveTab: 'dashboard',
  aiProcessing: false,
  aiProcessingProgress: null,
  aiCategoryCountsLastUpdate: 0,

  // Single source for "the category badge counts are stale, refetch now". The
  // badges (CategoryFilterBar) count unread-per-category from the DB and only
  // refetch when this timestamp changes (or on their 30s poll). Any action
  // that changes what that query sees — read state, the |important| category
  // tag, or folder membership (delete/archive/spam) — calls this AFTER its DB
  // write persists so the badge updates immediately instead of lagging.
  refreshCategoryCounts: () => set({ aiCategoryCountsLastUpdate: Date.now() }),

  search: async (query, context) => {
    if (!query.trim()) {
      activeSearchParsed = null;
      activeSearchContext = null;
      set({ searchQuery: '', searchResults: [], searchInterpretation: null, searchFilter: null, searchPage: 0, searchHasMore: false, searchTotal: 0, searchingServer: false, serverSearchRan: false, serverSearchStatus: null });
      return;
    }

    // A bare quick-filter (is:unread / is:read / is:starred / has:attachment /
    // is:unlabelled) doesn't run a flat search — it just narrows the EXISTING
    // sectioned inbox and paginates within it. Only route here when the current
    // view actually renders DB sections; otherwise fall through to a text search.
    const quickFilter = INBOX_QUICK_FILTERS[query.trim()];
    if (quickFilter) {
      const s = get();
      const isInbox = s.folders.find((f) => f.id === s.selectedFolderId)?.path === 'INBOX';
      const sectioned = s.inboxType !== 'default' && s.inboxSections.length > 0;
      const eligible = sectioned && s.selectedVirtualFolder !== 'virtual-unified'
        && !s.viewingAICategory && (isInbox || s.selectedVirtualFolder === 'virtual-all');
      if (eligible) {
        await get().setInboxFilter(quickFilter.filter, quickFilter.label);
        return;
      }
    }

    // A new query starts fresh: clear any prior server-search status so the chip
    // and the auto-escalation gate don't carry over from the last search.
    set({ searching: true, searchQuery: query, searchInterpretation: null, searchPage: 0, serverSearchRan: false, serverSearchStatus: null });

    // A slower search must not overwrite the results of a newer one (or a
    // cleared search) — bail before every set() if the query changed.
    const isStale = () => get().searchQuery !== query;

    try {
      const useAISearch = !context?.skipAI && isAISearchEnabled() && getDefaultProvider();
      console.log(`[Store] ${useAISearch ? 'AI-powered' : 'fast'} search with context:`, context);

      const aiResult = await parseSearchQuery(query);
      console.log('[Store] parsed query:', aiResult);
      if (isStale()) return;

      // Stash the parsed query + context so goToSearchPage can re-fetch any page
      // without re-parsing. Persist the predicate for the live state-token recheck.
      activeSearchParsed = aiResult.query;
      activeSearchContext = context ?? null;
      set({ searchInterpretation: aiResult.interpretation, searchFilter: aiResult.query, searchTotal: 0 });

      await get()._loadSearchPage(0, query);

      // True total for the paginator "of N" — one COUNT over the whole mailbox
      // (single-account path only; All Inboxes stays hasMore-gated). Fetched once
      // per new search, reused across pages.
      if (get().selectedVirtualFolder !== 'virtual-unified' && !isStale()) {
        try {
          const c = await window.electronAPI.ai.searchCount({ ...aiResult.query, folderId: context?.folderId, aiCategory: context?.aiCategory } as any);
          if (c?.success && typeof c.data === 'number' && !isStale()) set({ searchTotal: c.data });
        } catch { /* leave total unknown → hasMore-gated */ }
      }

      // Local-first escalation: when the local index came back thin for a query
      // the server can actually search (text/header/date), quietly run a server
      // search so mail that isn't downloaded yet still surfaces. Conservative —
      // first page only, once per query; the explicit button forces it anytime.
      if (!isStale() && shouldAutoEscalateToServer({
        hasServerSearchableTerms: hasServerSearchableParsedQuery(aiResult.query),
        localResultCount: get().searchResults.length,
        pageSize: getEmailsPerPage(),
        page: 0,
        alreadyRanServer: get().serverSearchRan,
        isUnifiedView: get().selectedVirtualFolder === 'virtual-unified',
      })) {
        await get()._runServerSearch(query, false);
      }
    } catch (error) {
      console.error('Failed to search:', error);
      try {
        const result = await window.electronAPI.emails.search(query);
        if (result.success && result.data && !isStale()) {
          set({ searchResults: result.data, searchPage: 0, searchHasMore: false });
        }
      } catch {
        // Ignore fallback error
      }
    } finally {
      // Skip only when a NEWER query owns the spinner; a cleared search
      // (searchQuery === '') still needs searching reset.
      if (!isStale() || !get().searchQuery) set({ searching: false });
    }
  },

  // Jump to a discrete page of the CURRENT search (Gmail-style prev/next), so a
  // filter matching thousands of mails pages through them all in getEmailsPerPage
  // chunks rather than being capped. Reuses the stashed parsed query + context.
  goToSearchPage: async (page) => {
    const query = get().searchQuery;
    if (!query || !activeSearchParsed) return;
    set({ searching: true });
    try {
      await get()._loadSearchPage(page, query);
    } finally {
      if (get().searchQuery === query) set({ searching: false });
    }
  },

  // Fetch one page (offset = page * pageSize) via the same route the initial
  // search used: single-account (ai.search), or on All Inboxes unifiedSearch
  // (free text) / unifiedInbox (pure filter). hasMore = a full page came back.
  _loadSearchPage: async (page, query) => {
    const isStale = () => get().searchQuery !== query;
    const q = activeSearchParsed;
    const context = activeSearchContext;
    if (!q) return;
    const pageSize = getEmailsPerPage();
    const offset = page * pageSize;
    // Not literally "has free text": the question is whether a ViewFilter could
    // carry this query, because the unifiedInbox route below takes nothing else.
    const hasFreeText = needsFullQuerySearch(q);

    if (get().selectedVirtualFolder === 'virtual-unified') {
      const accountIds = get().accounts.filter((a) => a.includeInUnified !== false).map((a) => a.id);
      if (hasFreeText) {
        const res = await window.electronAPI.accounts.unifiedSearch({
          accountIds,
          searchQuery: { ...q, aiCategory: context?.aiCategory ?? q.aiCategory },
          limit: pageSize,
          offset,
        });
        if (res?.success && res.data && !isStale()) set({ searchResults: res.data, searchPage: page, searchHasMore: res.data.length >= pageSize });
      } else {
        const filter = { isUnread: q.isUnread, isFlagged: q.isFlagged, hasAttachments: q.hasAttachments, noCategory: q.noCategory };
        const res = await window.electronAPI.accounts.unifiedInbox({ accountIds, limit: pageSize, offset, filter, aiCategory: context?.aiCategory ?? q.aiCategory });
        if (res?.success && res.data && !isStale()) set({ searchResults: res.data.emails, searchPage: page, searchHasMore: res.data.hasMore });
      }
      return;
    }

    const searchQuery = { ...q, folderId: context?.folderId, aiCategory: context?.aiCategory, limit: pageSize, offset };
    const searchResult = await window.electronAPI.ai.search(searchQuery);
    if (searchResult.success && searchResult.data && !isStale()) {
      set({ searchResults: searchResult.data, searchPage: page, searchHasMore: searchResult.data.length >= pageSize });
    }
  },

  // Explicit "Search server" affordance: force a server search for the active
  // query even when local returned plenty. Same worker as the auto path.
  searchServer: async () => {
    const query = get().searchQuery;
    if (!query || !activeSearchParsed) return;
    await get()._runServerSearch(query, true);
  },

  // Shared worker for both the automatic (thin-local) and manual escalations.
  // Sends the server-searchable fields to the main process, which runs the IMAP
  // UID SEARCH and pulls the newest MISSING matches into the local index; when
  // anything new lands we re-load the current local page so the rows appear
  // through the normal (already-paginated, already-deduped) search path.
  _runServerSearch: async (query, manual) => {
    if (get().searchQuery !== query || !activeSearchParsed) return;
    // Unified ("All Inboxes") has no single folder to SEARCH — skip silently.
    if (get().selectedVirtualFolder === 'virtual-unified') return;

    const parsed = activeSearchParsed;
    const context = activeSearchContext;
    const serverQuery = {
      textQuery: parsed.textQuery,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      isUnread: parsed.isUnread,
      isFlagged: parsed.isFlagged,
      dateFrom: parsed.dateFrom,
      dateTo: parsed.dateTo,
      sizeMin: parsed.sizeMin,
      sizeMax: parsed.sizeMax,
    };

    const isStale = () => get().searchQuery !== query;
    set({ searchingServer: true });
    try {
      const res = await window.electronAPI.emails.searchServer({
        query: serverQuery,
        folderId: context?.folderId,
      });
      if (isStale()) return;
      if (res?.success && res.data) {
        set({ serverSearchRan: true, serverSearchStatus: describeServerSearchResult(res.data) });
        // New rows were persisted — re-run the current page (and refresh the "of
        // N" total) so they show up through the ordinary local search path.
        if (res.data.inserted > 0) {
          await get()._loadSearchPage(get().searchPage, query);
          try {
            const c = await window.electronAPI.ai.searchCount({ ...parsed, folderId: context?.folderId, aiCategory: context?.aiCategory } as any);
            if (c?.success && typeof c.data === 'number' && !isStale()) set({ searchTotal: c.data });
          } catch { /* leave total as-is */ }
        }
      } else {
        // Mark it ran so auto-escalation doesn't loop; surface the error only
        // when the user explicitly asked (a silent auto attempt stays quiet).
        set({ serverSearchRan: true, serverSearchStatus: manual ? (res?.error ?? 'Server search failed') : null });
      }
    } catch (error) {
      if (!isStale()) set({ serverSearchRan: true, serverSearchStatus: manual ? 'Server search failed' : null });
    } finally {
      if (get().searchQuery === query) set({ searchingServer: false });
    }
  },

  clearSearch: () => {
    activeSearchParsed = null;
    activeSearchContext = null;
    set({ searchQuery: '', searchResults: [], searchInterpretation: null, searchSuggestions: [], searchFilter: null, searchPage: 0, searchHasMore: false, searchTotal: 0, searchingServer: false, serverSearchRan: false, serverSearchStatus: null });
  },

  // Apply (or toggle off) a quick-filter over the sectioned inbox. Same label
  // again — or an explicit null — clears it. Unlike a text search this stays in
  // the sectioned layout; it's just ANDed into every section query + its
  // pagination. sectionData is reset so stale (unfiltered) rows don't linger.
  setInboxFilter: async (filter, label) => {
    const clearing = !filter || (!!label && get().activeInboxFilterLabel === label);
    const s = get();
    const folder = s.folders.find((f) => f.id === s.selectedFolderId);
    const folderPath = s.selectedVirtualFolder === 'virtual-all' ? undefined : folder?.path;
    set({
      activeInboxFilter: clearing ? null : filter,
      activeInboxFilterLabel: clearing ? null : (label ?? null),
      // Guarantee the sectioned view is what's showing (not a text search or a
      // full-page section drill-down), so the filter is visibly applied at once.
      searchQuery: '', searchResults: [], searchInterpretation: null, searchFilter: null,
      searchPage: 0, searchHasMore: false, searchTotal: 0,
      viewingSection: null, viewingSectionLabel: null,
      sectionData: {},
    });
    await get().loadAllSections(folderPath);
  },

  fetchSearchSuggestions: async (partial: string) => {
    if (!partial || partial.length < 2) {
      set({ searchSuggestions: [] });
      return;
    }
    try {
      const result = await window.electronAPI.ai.searchSuggest(partial);
      if (result.success && result.data) {
        set({ searchSuggestions: result.data });
      }
    } catch {
      // Ignore suggestion errors
    }
  },

  loadAICategoryEmails: async (category) => {
    const { selectedFolderId, searchQuery, viewingAICategory: currentCategory, selectedVirtualFolder } = get();
    console.log(`[View] Selected: AI Category "${category}" (folderId=${selectedFolderId || 'all'}, searchQuery=${searchQuery || 'none'})`);

    // If search is active, re-run search with updated AI category context
    if (searchQuery) {
      set({ viewingAICategory: category });
      const context: { folderId?: string; aiCategory?: string } = { aiCategory: category };
      if (selectedFolderId) context.folderId = selectedFolderId;
      await get().search(searchQuery, context);
      return;
    }

    // A category list follows the user's setting whatever view it was opened
    // from — the same size the Paginator and goToEmailPage resolve.
    const PAGE_SIZE = getPageSizeForView({ aiCategory: category });
    // Differentiate between a NEW category selection (user intent — clear
    // slate is correct) and a BACKGROUND refresh of the same category (sync
    // just finished, merge additively so scroll/selection isn't nuked).
    const isRefresh = currentCategory === category;

    // Real total for the category so the paginator shows "1–N of total" (was hard-set
    // to 0) and the number matches the chip — from the SAME count source the chip uses.
    const fetchCategoryTotal = (): Promise<number> => fetchAICategoryTotal({
      category,
      selectedFolderId,
      selectedVirtualFolder,
      unifiedAccountIds: get().accounts.filter((a) => a.includeInUnified !== false).map((a) => a.id),
    });

    if (!isRefresh) {
      // Keep sectionData cached (not rendered in the AI-category view) so
      // returning to the sectioned INBOX shows it instantly instead of
      // hitting the full loading spinner. See selectFolder note.
      set({
        loadingEmails: true,
        emails: [],
        selectedEmailId: null,
        highlightedEmailId: null,
        viewingAICategory: category,
        viewingSnoozed: false,
        hasMoreEmails: false,
        emailsOffset: PAGE_SIZE,
        // Leaving a section full-page view — clear it so the category paginator
        // uses the category page size, not the stale section's.
        viewingSection: null, viewingSectionLabel: null, viewingSectionPageSize: SECTION_FULL_PAGE_SIZE,
        emailsPage: 0, emailsTotal: 0,
      });
    }
    // Bail if the user left this category (or this view) while in flight
    const isStale = () => get().viewingAICategory !== category;
    try {
      // On All Inboxes, browse the category across EVERY opted-in account (each
      // row tagged with its accountId for the color) instead of just the active
      // account — so category tabs respect the unified view like the list does.
      let result: { success: boolean; data?: any[]; error?: string };
      if (selectedVirtualFolder === 'virtual-unified') {
        const accountIds = get().accounts
          .filter((a) => a.includeInUnified !== false)
          .map((a) => a.id);
        const res = await window.electronAPI.accounts.unifiedInbox({ accountIds, limit: PAGE_SIZE, offset: 0, aiCategory: category });
        result = res?.success && res.data ? { success: true, data: res.data.emails } : { success: false, error: res?.error };
      } else {
        result = await window.electronAPI.ai.getByCategory(category, PAGE_SIZE, 0, selectedFolderId ?? undefined);
      }
      const total = await fetchCategoryTotal();
      if (isStale()) return;
      if (result.success && result.data) {
        if (isRefresh) {
          // Additive: update-in-place + prepend new; never drop existing rows.
          const fresh = result.data as any[];
          const currentEmails = get().emails;
          const existingIds = new Set(currentEmails.map(e => e.id));
          const freshMap = new Map<string, any>(fresh.map(e => [e.id, e]));
          const updated = currentEmails.map(e => {
            const f = freshMap.get(e.id);
            if (!f) return e;
            if (e.tags !== f.tags || e.date !== f.date || e.subject !== f.subject
              || (e as any).threadIsStarred !== (f as any).threadIsStarred
              || (e as any).threadIsImportant !== (f as any).threadIsImportant) return f;
            return e;
          });
          const newOnes = fresh.filter(e => !existingIds.has(e.id));
          if (newOnes.length > 0 || updated !== currentEmails) {
            const merged = [...newOnes, ...updated].sort((a, b) => (b.date || 0) - (a.date || 0));
            set({ emails: merged, emailsTotal: total });
          } else {
            set({ emailsTotal: total });
          }
        } else {
          set({
            emails: result.data,
            loadingEmails: false,
            hasMoreEmails: result.data.length >= PAGE_SIZE,
            emailsTotal: total,
          });
        }
      } else {
        console.error('[Store] Failed to load AI category emails:', result.error);
        if (!isRefresh) set({ loadingEmails: false });
      }
    } catch (error) {
      console.error('[Store] Error loading AI category emails:', error);
      if (!isRefresh) set({ loadingEmails: false });
    }
  },

  clearAICategoryView: () => {
    const { searchQuery, selectedFolderId } = get();
    set({ viewingAICategory: null });

    // If search is active, re-run search without AI category
    if (searchQuery) {
      const context: { folderId?: string } = {};
      if (selectedFolderId) context.folderId = selectedFolderId;
      get().search(searchQuery, context);
    }
  },

  setAIBoxActiveTab: (tab) => set({ aiBoxActiveTab: tab }),

  stopAIProcessing: () => {
    window.electronAPI.aiCategorization.stop();
    set({ aiProcessing: false, aiProcessingProgress: null });
    console.log('[Store] AI processing stopped by user');
  },

  processRecentEmailsForSignatures: async () => {
    if (!isSignatureDetectionEnabled()) {
      return;
    }

    try {
      console.log('[Store] Processing recent emails for signature detection...');

      const result = await window.electronAPI.emails.getRecent({ minutes: 10, limit: 20 });

      if (!result.success || !result.data || result.data.length === 0) {
        console.log('[Store] No recent emails to process for signatures');
        return;
      }

      console.log(`[Store] Found ${result.data.length} recent emails for signature detection`);

      for (const email of result.data) {
        const body = email.rawBody || email.cleanBody;
        if (!body || !email.fromAddress) {
          continue;
        }

        try {
          const signatureResult = await detectSignature(body, email.fromAddress, email.id);

          if (signatureResult.hasSignature) {
            console.log(`[Store] Signature detected for ${email.fromAddress}:`, signatureResult.htmlSelector);
          }
        } catch (error) {
          console.error(`[Store] Failed to detect signature for email ${email.id}:`, error);
        }
      }

      console.log('[Store] Signature detection processing complete');
    } catch (error) {
      console.error('[Store] Failed to process recent emails for signatures:', error);
    }
  },

  processEmailsForAICategorization: async () => {
    if (get().aiProcessing) {
      console.log('[Store] AI categorization already in progress');
      return;
    }

    if (!isCategorizationEnabled()) {
      console.log('[Store] AI categorization feature is disabled in settings');
      return;
    }

    const provider = getDefaultProvider();
    if (!provider) {
      console.log('[Store] No AI provider configured, skipping categorization');
      return;
    }

    let userEmail = '';
    try {
      const settingsStr = localStorage.getItem('sarvinbox-settings');
      if (settingsStr) {
        const settings = JSON.parse(settingsStr);
        userEmail = settings.profileEmail || '';
      }
      if (!userEmail) {
        const credsStr = localStorage.getItem('sarvinbox-credentials');
        if (credsStr) {
          const creds = JSON.parse(credsStr);
          userEmail = creds.username || '';
        }
      }
    } catch { /* ignore */ }

    const maxAIEmails = getMaxAIProcessingEmails();

    set({ aiProcessing: true });

    console.log('[Store] Starting AI categorization via main process');
    await window.electronAPI.aiCategorization.start(
      {
        type: provider.type,
        apiKey: provider.apiKey,
        model: provider.model,
        baseUrl: provider.baseUrl,
        authMethod: provider.authMethod,
        oauthProvider: provider.oauthProvider,
        oauthEmail: provider.oauthEmail,
      },
      'bulk',
      {
        userEmail,
        maxEmails: maxAIEmails,
        skipRead: true,
      }
    );
  },

  startAutoAICategorization: () => {
    if (!isCategorizationEnabled()) {
      return;
    }
    // Pause while AI is marked inactive (provider failing) — avoids
    // hammering a broken provider. Resumes once a passing Test (or a
    // recovered call) flips health back to healthy.
    if (!getAIHealth().healthy) {
      return;
    }

    const provider = getDefaultProvider();
    if (!provider) {
      return;
    }

    let userEmail = '';
    try {
      const settingsStr = localStorage.getItem('sarvinbox-settings');
      if (settingsStr) {
        const settings = JSON.parse(settingsStr);
        userEmail = settings.profileEmail || '';
      }
      if (!userEmail) {
        const credsStr = localStorage.getItem('sarvinbox-credentials');
        if (credsStr) {
          const creds = JSON.parse(credsStr);
          userEmail = creds.username || '';
        }
      }
    } catch { /* ignore */ }

    // Carry OAuth metadata through so main-process can attach a fresh-
    // bearer resolver. For plain apiKey providers these fields are
    // undefined and the wrapper becomes a no-op.
    const aiPayload = {
      type: provider.type,
      apiKey: provider.apiKey,
      model: provider.model,
      baseUrl: provider.baseUrl,
      authMethod: provider.authMethod,
      oauthProvider: provider.oauthProvider,
      oauthEmail: provider.oauthEmail,
    };

    // The renderer-driven auto-categorization loop (aiCategorization.startAuto)
    // was RETIRED here: the unified pipeline is now the SOLE automatic
    // categorizer (it categorizes on the email:synced event plus its own 30s
    // poll). Running both double-categorized the same emails — they gated on
    // different completion columns (this loop wrote only ai_processed_at; the
    // pipeline gates on agent_status), so a mail categorized here got
    // re-categorized by the pipeline = duplicate LLM call / double token spend.
    // Manual categorization (ai-categorization:start) is unaffected. We still
    // push the AI config to the pipeline below so it can run.

    // Pass AI config + userEmail to unified pipeline
    window.electronAPI.agent.setAIConfig(aiPayload).catch(() => {});
    // Pass userEmail so pipeline can classify contacts and build memories
    if (userEmail) {
      window.electronAPI.agent.setConfig({ userEmail } as any).catch(() => {});
    }
  },

  autoExtractRecentConversations: async () => {
    if (autoExtractRunning) {
      console.log('[AutoExtract] Previous pass still running, skipping');
      return;
    }
    if (!isAutoChatExtractEnabled() || !isConversationModeEnabled()) {
      return;
    }
    if (!getAIHealth().healthy) {
      return; // AI inactive — pause background extraction until fixed
    }
    const provider = getDefaultProvider();
    if (!provider) return;

    autoExtractRunning = true;
    try {
      // Get recent emails (last 10 min) to find threads that need extraction
      const result = await window.electronAPI.emails.getRecent({ minutes: 10, limit: 50 });
      if (!result.success || !result.data || result.data.length === 0) return;

      // Collect unique threadIds
      const threadIds = [...new Set(result.data.map((e: any) => e.threadId).filter(Boolean))] as string[];
      if (threadIds.length === 0) return;

      console.log(`[AutoExtract] Processing ${threadIds.length} thread(s) from recent emails`);

      for (const threadId of threadIds) {
        try {
          // Get all emails in this thread
          const threadResult = await window.electronAPI.emails.getThread(threadId);
          if (!threadResult.success || !threadResult.data || threadResult.data.length < 2) {
            continue; // Skip single-email threads
          }

          const emails = threadResult.data;
          const userEmail = emails[0]?.toAddress || '';

          // extractConversation handles caching + incremental — only processes new emails
          await extractConversation(threadId, emails, userEmail);
          console.log(`[AutoExtract] Thread ${threadId} extracted (${emails.length} emails)`);
        } catch (err) {
          console.error(`[AutoExtract] Failed to extract thread ${threadId}:`, err);
        }
      }

      console.log('[AutoExtract] Background extraction complete');
    } catch (error) {
      console.error('[AutoExtract] Failed:', error);
    } finally {
      autoExtractRunning = false;
    }
  },
});
