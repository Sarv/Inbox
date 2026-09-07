import type { FilterCondition } from '@sarvinbox/core';
import { Filter as FilterIcon, Paperclip, X } from 'lucide-react';
import { useState, useEffect, useRef, useCallback } from 'react';

import { useEmailStore } from '../store/email-store';
import { setPendingFilterDraft } from '../utils/filter-draft-bridge';

interface Contact {
  id: string;
  email: string;
  name: string | null;
  displayName: string | null;
}

interface AdvancedSearchParams {
  from: string;
  to: string;
  subject: string;
  hasWords: string;
  doesntHave: string;
  sizeOperator: 'greater' | 'less';
  sizeValue: string;
  sizeUnit: 'MB' | 'KB' | 'bytes';
  dateWithin: string;
  dateValue: string;
  searchIn: string;
  hasAttachment: boolean;
}

interface AdvancedSearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSearch: (query: string, skipAI?: boolean) => void;
  initialQuery?: string;
}

// Contact autocomplete input component
function ContactAutocomplete({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
}) {
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  // Fetch contact suggestions
  const fetchSuggestions = useCallback(async (search: string) => {
    if (!search || search.length < 1) {
      setSuggestions([]);
      return;
    }

    setLoading(true);
    try {
      const result = await window.electronAPI.contacts.list({
        limit: 10,
        offset: 0,
        search,
        sortBy: 'relevance',
        sortOrder: 'desc',
      });

      if (result.success && result.data) {
        setSuggestions(result.data.contacts || []);
      }
    } catch (error) {
      console.error('Failed to fetch contacts:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchSuggestions(value);
    }, 150);
    return () => clearTimeout(timer);
  }, [value, fetchSuggestions]);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSelect = (contact: Contact) => {
    onChange(contact.email);
    setShowSuggestions(false);
    inputRef.current?.blur();
  };

  return (
    <div className="flex items-center gap-4">
      <label className="w-28 text-sm text-muted-foreground flex-shrink-0">{label}</label>
      <div className="flex-1 relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setShowSuggestions(true)}
          placeholder={placeholder}
          className="w-full px-3 py-1.5 bg-background border-b border-input focus:border-primary focus:outline-none text-sm"
        />

        {/* Suggestions dropdown */}
        {showSuggestions && (value.length > 0 || suggestions.length > 0) && (
          <div
            ref={suggestionsRef}
            className="absolute left-0 right-0 top-full mt-1 bg-popover border border-border rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto"
          >
            {loading ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">Loading...</div>
            ) : suggestions.length > 0 ? (
              suggestions.map((contact) => (
                <button
                  key={contact.id}
                  onClick={() => handleSelect(contact)}
                  className="w-full px-3 py-2 text-left hover:bg-accent flex items-center gap-2 text-sm"
                >
                  <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium text-primary flex-shrink-0">
                    {(contact.name || contact.email)[0].toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    {contact.name && (
                      <div className="font-medium truncate">{contact.name}</div>
                    )}
                    <div className={`truncate ${contact.name ? 'text-muted-foreground text-xs' : ''}`}>
                      {contact.email}
                    </div>
                  </div>
                </button>
              ))
            ) : value.length > 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">No contacts found</div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export function AdvancedSearchPanel({ isOpen, onClose, onSearch, initialQuery = '' }: AdvancedSearchPanelProps) {
  const { folders } = useEmailStore();

  const [params, setParams] = useState<AdvancedSearchParams>({
    from: '',
    to: '',
    subject: '',
    hasWords: '',
    doesntHave: '',
    sizeOperator: 'greater',
    sizeValue: '',
    sizeUnit: 'MB',
    dateWithin: '',
    dateValue: '',
    searchIn: 'all',
    hasAttachment: false,
  });

  // Parse initial query into fields
  useEffect(() => {
    if (initialQuery) {
      const newParams = { ...params };

      // Parse from:
      const fromMatch = initialQuery.match(/from:(\S+)/i);
      if (fromMatch) newParams.from = fromMatch[1];

      // Parse to:
      const toMatch = initialQuery.match(/to:(\S+)/i);
      if (toMatch) newParams.to = toMatch[1];

      // Parse subject:
      const subjectMatch = initialQuery.match(/subject:(?:"([^"]+)"|(\S+))/i);
      if (subjectMatch) newParams.subject = subjectMatch[1] || subjectMatch[2];

      // Parse has:attachment
      if (/has:attachment/i.test(initialQuery)) {
        newParams.hasAttachment = true;
      }

      // Parse label:/in:
      const labelMatch = initialQuery.match(/(?:label:|in:)(\S+)/i);
      if (labelMatch) newParams.searchIn = labelMatch[1];

      // Parse larger:/smaller:
      const sizeMatch = initialQuery.match(/(larger|smaller):(\d+)([mk]?)/i);
      if (sizeMatch) {
        newParams.sizeOperator = sizeMatch[1].toLowerCase() === 'larger' ? 'greater' : 'less';
        newParams.sizeValue = sizeMatch[2];
        newParams.sizeUnit = sizeMatch[3]?.toLowerCase() === 'm' ? 'MB' : sizeMatch[3]?.toLowerCase() === 'k' ? 'KB' : 'bytes';
      }

      // Remaining text as "has words"
      const remaining = initialQuery
        .replace(/from:\S+/gi, '')
        .replace(/to:\S+/gi, '')
        .replace(/subject:(?:"[^"]+"|(\S+))/gi, '')
        .replace(/has:attachment/gi, '')
        .replace(/(?:label:|in:)\S+/gi, '')
        .replace(/(larger|smaller):\S+/gi, '')
        .replace(/-\S+/g, '') // Remove negated terms
        .trim();

      if (remaining) newParams.hasWords = remaining;

      // Parse negated terms
      const negatedMatch = initialQuery.match(/-(\S+)/g);
      if (negatedMatch) {
        newParams.doesntHave = negatedMatch.map(t => t.slice(1)).join(' ');
      }

      setParams(newParams);
    }
  }, [initialQuery]);

  const buildSearchQuery = (): string => {
    const parts: string[] = [];

    if (params.from.trim()) {
      parts.push(`from:${params.from.trim()}`);
    }

    if (params.to.trim()) {
      parts.push(`to:${params.to.trim()}`);
    }

    if (params.subject.trim()) {
      const subject = params.subject.trim();
      parts.push(subject.includes(' ') ? `subject:"${subject}"` : `subject:${subject}`);
    }

    if (params.hasWords.trim()) {
      parts.push(params.hasWords.trim());
    }

    if (params.doesntHave.trim()) {
      const words = params.doesntHave.trim().split(/\s+/);
      words.forEach(word => parts.push(`-${word}`));
    }

    if (params.sizeValue.trim()) {
      const operator = params.sizeOperator === 'greater' ? 'larger' : 'smaller';
      const unitSuffix = params.sizeUnit === 'MB' ? 'm' : params.sizeUnit === 'KB' ? 'k' : '';
      parts.push(`${operator}:${params.sizeValue}${unitSuffix}`);
    }

    if (params.dateWithin && params.dateValue) {
      // Convert to after: date format
      const date = new Date(params.dateValue);
      const days = parseInt(params.dateWithin);
      if (!isNaN(days)) {
        const afterDate = new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
        parts.push(`after:${afterDate.toISOString().split('T')[0]}`);
        parts.push(`before:${date.toISOString().split('T')[0]}`);
      }
    }

    if (params.searchIn && params.searchIn !== 'all') {
      parts.push(`in:${params.searchIn}`);
    }

    if (params.hasAttachment) {
      parts.push('has:attachment');
    }

    return parts.join(' ');
  };

  const handleSearch = () => {
    const query = buildSearchQuery();
    // Pass skipAI=true since this is a structured query
    onSearch(query, true);
    onClose();
  };

  // Map the text criteria to filter-rule conditions. Only the fields a filter can
  // match on carry over (from/to/subject/words); size, date and attachment have
  // no FilterCondition equivalent, so they're deliberately dropped — mirrors
  // Gmail, where "Create filter" keeps the matchable criteria and drops the rest.
  const buildFilterConditions = (): FilterCondition[] => {
    const conditions: FilterCondition[] = [];
    if (params.from.trim()) conditions.push({ field: 'from', operator: 'contains', value: params.from.trim() });
    if (params.to.trim()) conditions.push({ field: 'to', operator: 'contains', value: params.to.trim() });
    if (params.subject.trim()) conditions.push({ field: 'subject', operator: 'contains', value: params.subject.trim() });
    if (params.hasWords.trim()) conditions.push({ field: 'body', operator: 'contains', value: params.hasWords.trim() });
    if (params.doesntHave.trim()) conditions.push({ field: 'body', operator: 'notContains', value: params.doesntHave.trim() });
    return conditions;
  };

  const hasFilterableCriteria =
    !!(params.from.trim() || params.to.trim() || params.subject.trim() || params.hasWords.trim() || params.doesntHave.trim());

  // Turn the current criteria into a new filter: stash a pre-filled draft and
  // deep-link to Settings → Filters, where the user picks the actions and saves.
  const handleCreateFilter = () => {
    setPendingFilterDraft({ name: '', matchType: 'all', conditions: buildFilterConditions() });
    document.dispatchEvent(new CustomEvent('sarvinbox:open-settings', { detail: { tab: 'filters' } }));
    onClose();
  };

  const handleClear = () => {
    setParams({
      from: '',
      to: '',
      subject: '',
      hasWords: '',
      doesntHave: '',
      sizeOperator: 'greater',
      sizeValue: '',
      sizeUnit: 'MB',
      dateWithin: '',
      dateValue: '',
      searchIn: 'all',
      hasAttachment: false,
    });
  };

  if (!isOpen) return null;

  // Build folder options for the Search dropdown
  const folderOptions = [
    { value: 'all', label: 'All Mail' },
    { value: 'inbox', label: 'Inbox' },
    { value: 'sent', label: 'Sent' },
    { value: 'drafts', label: 'Drafts' },
    { value: 'trash', label: 'Trash' },
    { value: 'spam', label: 'Spam' },
    { value: 'starred', label: 'Starred' },
    { value: 'unread', label: 'Unread' },
    { value: 'read', label: 'Read' },
    ...folders
      .filter(f => !['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam'].includes(f.path))
      .map(f => ({ value: f.path.toLowerCase().replace(/\s+/g, '-'), label: f.name }))
  ];

  return (
    <div className="absolute left-0 top-full mt-1 bg-popover border border-border rounded-lg shadow-xl z-[100] overflow-hidden w-[560px]">
      {/* Header with close button */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/30">
        <span className="text-sm font-medium">Advanced Search</span>
        <button
          onClick={onClose}
          className="p-1 hover:bg-accent rounded-md text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Form Content */}
      <div className="p-5 space-y-4">
        {/* From - with autocomplete */}
        <ContactAutocomplete
          label="From"
          value={params.from}
          onChange={(value) => setParams({ ...params, from: value })}
        />

        {/* To - with autocomplete */}
        <ContactAutocomplete
          label="To"
          value={params.to}
          onChange={(value) => setParams({ ...params, to: value })}
        />

        {/* Subject */}
        <div className="flex items-center gap-4">
          <label className="w-28 text-sm text-muted-foreground flex-shrink-0">Subject</label>
          <input
            type="text"
            value={params.subject}
            onChange={(e) => setParams({ ...params, subject: e.target.value })}
            placeholder=""
            className="flex-1 px-3 py-1.5 bg-background border-b border-input focus:border-primary focus:outline-none text-sm"
          />
        </div>

        {/* Has the words */}
        <div className="flex items-center gap-4">
          <label className="w-28 text-sm text-muted-foreground flex-shrink-0">Has the words</label>
          <input
            type="text"
            value={params.hasWords}
            onChange={(e) => setParams({ ...params, hasWords: e.target.value })}
            placeholder=""
            className="flex-1 px-3 py-1.5 bg-background border-b border-input focus:border-primary focus:outline-none text-sm"
          />
        </div>

        {/* Doesn't have */}
        <div className="flex items-center gap-4">
          <label className="w-28 text-sm text-muted-foreground flex-shrink-0">Doesn't have</label>
          <input
            type="text"
            value={params.doesntHave}
            onChange={(e) => setParams({ ...params, doesntHave: e.target.value })}
            placeholder=""
            className="flex-1 px-3 py-1.5 bg-background border-b border-input focus:border-primary focus:outline-none text-sm"
          />
        </div>

        {/* Size */}
        <div className="flex items-center gap-4">
          <label className="w-28 text-sm text-muted-foreground flex-shrink-0">Size</label>
          <div className="flex-1 flex items-center gap-2">
            <select
              value={params.sizeOperator}
              onChange={(e) => setParams({ ...params, sizeOperator: e.target.value as 'greater' | 'less' })}
              className="px-2 py-1.5 bg-background border-b border-input focus:border-primary focus:outline-none text-sm cursor-pointer"
            >
              <option value="greater">greater than</option>
              <option value="less">less than</option>
            </select>
            <input
              type="number"
              value={params.sizeValue}
              onChange={(e) => setParams({ ...params, sizeValue: e.target.value })}
              placeholder=""
              className="w-16 px-2 py-1.5 bg-background border-b border-input focus:border-primary focus:outline-none text-sm"
            />
            <select
              value={params.sizeUnit}
              onChange={(e) => setParams({ ...params, sizeUnit: e.target.value as 'MB' | 'KB' | 'bytes' })}
              className="px-2 py-1.5 bg-background border-b border-input focus:border-primary focus:outline-none text-sm cursor-pointer"
            >
              <option value="MB">MB</option>
              <option value="KB">KB</option>
              <option value="bytes">bytes</option>
            </select>
          </div>
        </div>

        {/* Date within */}
        <div className="flex items-center gap-4">
          <label className="w-28 text-sm text-muted-foreground flex-shrink-0">Date within</label>
          <div className="flex-1 flex items-center gap-2">
            <select
              value={params.dateWithin}
              onChange={(e) => setParams({ ...params, dateWithin: e.target.value })}
              className="px-2 py-1.5 bg-background border-b border-input focus:border-primary focus:outline-none text-sm cursor-pointer min-w-[90px]"
            >
              <option value="">Select...</option>
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">1 week</option>
              <option value="14">2 weeks</option>
              <option value="30">1 month</option>
              <option value="60">2 months</option>
              <option value="180">6 months</option>
              <option value="365">1 year</option>
            </select>
            <input
              type="date"
              value={params.dateValue}
              onChange={(e) => setParams({ ...params, dateValue: e.target.value })}
              className="flex-1 px-2 py-1.5 bg-background border-b border-input focus:border-primary focus:outline-none text-sm min-w-0"
            />
          </div>
        </div>

        {/* Search in */}
        <div className="flex items-center gap-4">
          <label className="w-28 text-sm text-muted-foreground flex-shrink-0">Search</label>
          <select
            value={params.searchIn}
            onChange={(e) => setParams({ ...params, searchIn: e.target.value })}
            className="flex-1 px-3 py-1.5 bg-background border-b border-input focus:border-primary focus:outline-none text-sm cursor-pointer"
          >
            {folderOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        {/* Has attachment */}
        <div className="flex items-center gap-4">
          <label className="w-28 text-sm text-muted-foreground flex-shrink-0"></label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={params.hasAttachment}
              onChange={(e) => setParams({ ...params, hasAttachment: e.target.checked })}
              className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
            />
            <Paperclip className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Has attachment</span>
          </label>
        </div>
      </div>

      {/* Footer with buttons */}
      <div className="flex items-center justify-end gap-4 px-5 py-4 border-t border-border bg-muted/30">
        <button
          onClick={handleClear}
          className="px-5 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Clear
        </button>
        <button
          onClick={handleCreateFilter}
          disabled={!hasFilterableCriteria}
          title={hasFilterableCriteria ? 'Create a filter from these criteria' : 'Add From, To, Subject or words first'}
          className="px-4 py-2 border border-input rounded-md text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
        >
          <FilterIcon className="h-4 w-4" />
          Create filter
        </button>
        <button
          onClick={handleSearch}
          className="px-6 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Search
        </button>
      </div>
    </div>
  );
}
