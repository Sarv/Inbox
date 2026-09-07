import { X } from 'lucide-react';
import { useState, KeyboardEvent, useRef, useEffect, useCallback, useMemo } from 'react';

import { Avatar } from './Avatar';

interface EmailInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  onTabOut?: () => void;
  onPendingChange?: (value: string) => void;
}

interface ContactSuggestion {
  id: string;
  email: string;
  name: string | null;
  displayName: string | null;
  lastSeen: number;
  emailCount: number;
}

// Simple email validation regex
const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
};

// Extract email from "Name <email>" format or return as-is
const extractEmail = (input: string): string => {
  const match = input.match(/<([^>]+)>/);
  return match ? match[1].trim() : input.trim();
};

// Extract display name from "Name <email>" format
const extractName = (input: string): string | null => {
  const match = input.match(/^(.+?)\s*<[^>]+>$/);
  return match ? match[1].trim() : null;
};

// Validate email or "Name <email>" format
const isValidEmailFormat = (input: string): boolean => {
  const email = extractEmail(input);
  return isValidEmail(email);
};

// Capitalize first letter of each word
const capitalizeWords = (str: string): string => {
  return str
    .split(/[\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
};

// Format contact display name with proper capitalization
const formatDisplayName = (contact: { displayName: string | null; name: string | null; email: string }): string => {
  const name = contact.displayName || contact.name || contact.email.split('@')[0];
  return capitalizeWords(name);
};

export function EmailInput({ value, onChange, placeholder, autoFocus, onTabOut, onPendingChange }: EmailInputProps) {
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (onPendingChange) {
      onPendingChange(inputValue);
    }
  }, [inputValue, onPendingChange]);

  // Parse emails from value string
  const emails = useMemo(() =>
    value ? value.split(',').map(e => e.trim()).filter(Boolean) : [],
    [value]
  );

  // Get just the email addresses for duplicate checking
  const emailAddresses = useMemo(() =>
    emails.map(e => extractEmail(e).toLowerCase()),
    [emails]
  );

  // Ref to track current email addresses (avoids dependency issues)
  const emailAddressesRef = useRef<string[]>([]);
  emailAddressesRef.current = emailAddresses;

  // Single auto-clear timer for the transient error message. Held in a ref so
  // we can clear the previous one before scheduling a new flash, and clear it
  // on unmount so we never setState after the component is gone.
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deferred blur-commit timer (see handleBlur) — tracked so it can be
  // cleared on unmount, avoiding a setState after the component is gone.
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashError = useCallback((message: string, ms: number) => {
    setError(message);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      errorTimerRef.current = null;
      setError(null);
    }, ms);
  }, []);

  // Clear any pending timers on unmount.
  useEffect(() => () => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
  }, []);

  // Search contacts function with smart sorting
  // Uses 'relevance' sort which weights recent activity higher than total count
  const searchContacts = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    setLoading(true);
    try {
      // Use 'relevance' sort: recent contacts rank higher even with fewer emails
      const result = await window.electronAPI.contacts.list({
        limit: 15,
        offset: 0,
        search: query,
        sortBy: 'relevance',
        sortOrder: 'desc',
      });

      if (result.success && result.data) {
        const queryLower = query.toLowerCase();
        const currentEmailAddresses = emailAddressesRef.current;

        // Apply additional sort for exact matches within relevance-sorted results
        const sorted = [...result.data.contacts].sort((a, b) => {
          const aEmail = a.email.toLowerCase();
          const bEmail = b.email.toLowerCase();
          const aName = (a.displayName || a.name || '').toLowerCase();
          const bName = (b.displayName || b.name || '').toLowerCase();

          // Exact email match gets highest priority
          const aExactEmail = aEmail === queryLower;
          const bExactEmail = bEmail === queryLower;
          if (aExactEmail && !bExactEmail) return -1;
          if (bExactEmail && !aExactEmail) return 1;

          // Name starts with query (prioritized over email prefix)
          const aStartsName = aName.startsWith(queryLower);
          const bStartsName = bName.startsWith(queryLower);
          if (aStartsName && !bStartsName) return -1;
          if (bStartsName && !aStartsName) return 1;

          // Email starts with query
          const aStartsEmail = aEmail.startsWith(queryLower);
          const bStartsEmail = bEmail.startsWith(queryLower);
          if (aStartsEmail && !bStartsEmail) return -1;
          if (bStartsEmail && !aStartsEmail) return 1;

          // Keep backend relevance order for other cases
          return 0;
        });

        // Filter out already added emails, limit to 10
        const filtered = sorted.filter(c => !currentEmailAddresses.includes(c.email.toLowerCase())).slice(0, 10);

        setSuggestions(filtered);
        setShowSuggestions(filtered.length > 0);
        setSelectedIndex(0);
      }
    } catch (error) {
      console.error('Failed to search contacts:', error);
    } finally {
      setLoading(false);
    }
  }, []); // No dependencies - uses ref for current values

  // Debounced search on input change
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (inputValue.length >= 2) {
      debounceRef.current = setTimeout(() => {
        searchContacts(inputValue);
      }, 150);
    } else {
      setSuggestions([]);
      setShowSuggestions(false);
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [inputValue, searchContacts]);

  // Close suggestions on click outside
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

  // Delayed autoFocus — avoids capturing the keyboard shortcut key (e.g. "f" for forward)
  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => {
      inputRef.current?.focus();
    }, 120);
    return () => clearTimeout(timer);
  }, []);

  const selectSuggestion = (contact: ContactSuggestion) => {
    // Check for duplicates
    if (emailAddresses.includes(contact.email.toLowerCase())) {
      flashError('Email already added', 2000);
      setInputValue('');
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    // Format as "Name <email>" if name exists, otherwise just email
    const name = contact.displayName || contact.name;
    const formatted = name ? `${capitalizeWords(name)} <${contact.email}>` : contact.email;

    const newEmails = [...emails, formatted];
    onChange(newEmails.join(', '));
    setInputValue('');
    setSuggestions([]);
    setShowSuggestions(false);
    setSelectedIndex(0);
    inputRef.current?.focus();
  };

  const addEmail = (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Validate email format (handles both plain email and "Name <email>")
    if (!isValidEmailFormat(trimmed)) {
      flashError(`Invalid email: ${trimmed}`, 2000);
      return;
    }

    // Extract email for duplicate check
    const emailOnly = extractEmail(trimmed).toLowerCase();

    // Check for duplicates
    if (emailAddresses.includes(emailOnly)) {
      flashError('Email already added', 2000);
      setInputValue('');
      return;
    }

    const newEmails = [...emails, trimmed];
    onChange(newEmails.join(', '));
    setInputValue('');
    setError(null);
  };

  const removeEmail = (index: number) => {
    const newEmails = emails.filter((_, i) => i !== index);
    onChange(newEmails.join(', '));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Handle suggestion navigation
    if (showSuggestions && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev =>
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev =>
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        return;
      }
      if (e.key === 'Enter' && selectedIndex >= 0) {
        e.preventDefault();
        selectSuggestion(suggestions[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSuggestions(false);
        setSelectedIndex(0);
        return;
      }
      if (e.key === 'Tab' && selectedIndex >= 0) {
        e.preventDefault();
        selectSuggestion(suggestions[selectedIndex]);
        return;
      }
    }

    if (e.key === 'Tab' && onTabOut) {
      // If no suggestion selected, commit current input and move to next field
      if (inputValue.trim()) {
        addEmail(inputValue);
        setShowSuggestions(false);
      }
      e.preventDefault();
      onTabOut();
      return;
    }

    if (e.key === 'Enter' || e.key === ',' || e.key === ' ') {
      e.preventDefault();
      if (inputValue.trim()) {
        addEmail(inputValue);
        setShowSuggestions(false);
      }
    } else if (e.key === 'Backspace' && !inputValue && emails.length > 0) {
      // Remove last email when backspace is pressed on empty input
      removeEmail(emails.length - 1);
    }
  };

  const handleBlur = () => {
    // Delay to allow suggestion click to register
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    blurTimerRef.current = setTimeout(() => {
      blurTimerRef.current = null;
      if (inputValue.trim() && !showSuggestions) {
        addEmail(inputValue);
      }
    }, 150);
  };

  const handleFocus = () => {
    if (inputValue.length >= 2 && suggestions.length > 0) {
      setShowSuggestions(true);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pastedText = e.clipboardData.getData('text');
    // Split by comma, semicolon, space, or newline
    const pastedEmails = pastedText.split(/[,;\s\n]+/).filter(Boolean);

    const validEmails: string[] = [];
    const invalidEmails: string[] = [];

    pastedEmails.forEach(pastedEmail => {
      const trimmed = pastedEmail.trim();
      const emailOnly = extractEmail(trimmed).toLowerCase();
      if (trimmed && !emailAddresses.includes(emailOnly)) {
        if (isValidEmailFormat(trimmed)) {
          validEmails.push(trimmed);
        } else {
          invalidEmails.push(trimmed);
        }
      }
    });

    if (validEmails.length > 0) {
      const newEmails = [...emails, ...validEmails];
      onChange(newEmails.join(', '));
    }

    if (invalidEmails.length > 0) {
      flashError(`Invalid: ${invalidEmails.slice(0, 2).join(', ')}${invalidEmails.length > 2 ? '...' : ''}`, 3000);
    }
  };

  // Render email chip with name and email formatted nicely
  const renderEmailChip = (emailStr: string, index: number) => {
    const name = extractName(emailStr);
    const email = extractEmail(emailStr);

    return (
      <span
        key={index}
        className="inline-flex items-center gap-1 px-2 py-0.5 bg-accent text-accent-foreground rounded-md text-sm"
        title={emailStr}
      >
        {name ? (
          <>
            <span className="font-medium">{capitalizeWords(name)}</span>
            <span className="text-muted-foreground text-xs">&lt;{email}&gt;</span>
          </>
        ) : (
          email
        )}
        <button
          type="button"
          onClick={() => removeEmail(index)}
          className="hover:bg-muted-foreground/20 rounded-full p-0.5 ml-0.5"
        >
          <X className="h-3 w-3" />
        </button>
      </span>
    );
  };

  return (
    <div className="flex-1 flex flex-wrap items-center gap-1.5 px-2 py-2 min-h-[44px] relative">
      {emails.map((email, index) => renderEmailChip(email, index))}
      <div className="relative flex-1 min-w-[120px]">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onFocus={handleFocus}
          onPaste={handlePaste}
          placeholder={emails.length === 0 ? placeholder : ''}
          className="w-full bg-transparent outline-none text-sm"
          autoComplete="off"
        /* autoFocus handled via useEffect below to avoid capturing the triggering keypress */
        />

        {/* Suggestions Dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div
            ref={suggestionsRef}
            className="absolute left-0 top-full mt-1 w-72 max-h-60 overflow-y-auto bg-popover border border-border rounded-md shadow-lg z-50"
          >
            {suggestions.map((contact, index) => (
              <button
                key={contact.id}
                type="button"
                onClick={() => selectSuggestion(contact)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-accent transition-colors ${index === selectedIndex ? 'bg-accent' : ''
                  }`}
              >
                {/* Avatar: colored initials + Gravatar photo when available */}
                <Avatar email={contact.email} name={formatDisplayName(contact)} size={32} />

                {/* Contact Info */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {formatDisplayName(contact)}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    {contact.email}
                  </div>
                </div>

                {/* Email count badge */}
                <div className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded flex-shrink-0">
                  {contact.emailCount}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Loading indicator */}
        {loading && inputValue.length >= 2 && (
          <div className="absolute right-0 top-1/2 -translate-y-1/2">
            <div className="w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>
      {error && (
        <span className="text-xs text-destructive">{error}</span>
      )}
    </div>
  );
}
