import { parsePhoneNumberFromString } from 'libphonenumber-js';
import {
  Search,
  User,
  Mail,
  Star,
  Trash2,
  RefreshCw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Phone,
  Building,
  Calendar,
  Send,
  Inbox,
  Eye,
  Archive,
  Tag,
  Plus,
  Pencil,
  Check,
  X,
  StickyNote,
  Sparkles,
  Linkedin,
  Twitter,
  Github,
  Globe,
  Briefcase,
  MapPin,
  ExternalLink,
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

import { enrichContact } from '../services/contact-enrichment-service';

import { Avatar } from './Avatar';
import { Tooltip } from './Tooltip';

/**
 * Render any phone number in one consistent international format
 * ("+91 88990 01122") via libphonenumber-js, so a contact's office/direct
 * numbers don't show up in the mismatched shapes senders type. Falls back to
 * the original string when the value can't be parsed as a phone number.
 */
function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const parsed = parsePhoneNumberFromString(raw, 'IN');
    if (parsed && parsed.isValid()) return parsed.formatInternational();
  } catch { /* not a parseable number — show as-is */ }
  return raw;
}

interface ContactEnrichmentView {
  designation?: string | null;
  department?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  companyWebsite?: string | null;
  companyAddress?: string | null;
  linkedinUrl?: string | null;
  twitterUrl?: string | null;
  githubUrl?: string | null;
  personalPhone?: string | null;
  companyPhone?: string | null;
  whatsappNumber?: string | null;
  personalEmail?: string | null;
  location?: string | null;
  pronouns?: string | null;
  otherSocials?: Array<{ platform: string; url: string }>;
  notes?: string | null;
}

interface Contact {
  id: string;
  email: string;
  name: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  avatarStatus: 'pending' | 'confirmed' | 'rejected' | null;
  organization: string | null;
  title: string | null;
  phone: string | null;
  firstSeen: number;
  lastSeen: number;
  emailCount: number;
  sentCount: number;
  receivedCount: number;
  isFavorite: boolean;
  notes: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  // Agent classification (same contacts table — no parallel store)
  contactType?: string | null;
  contactTypeConfidence?: number | null;
  contactTypeSource?: string | null;
  // Enrichment (v39)
  kind?: 'individual' | 'company' | null;
  personId?: string | null;
  companyContactId?: string | null;
  mobileE164?: string | null;
  enrichment?: ContactEnrichmentView | null;
  enrichedThroughEmailAt?: number | null;
  enrichmentSource?: 'llm' | 'user' | null;
}

interface ContactNote {
  id: number;
  email: string;
  note: string;
  category: string;
  createdAt: number;
  sourceEmailId?: string | null;
}

// Mirror of agent types — keep in lockstep with AgentDashboard's CONTACT_TYPE_LABELS
const CONTACT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'existing_customer', label: 'Customer' },
  { value: 'potential_customer', label: 'Prospect' },
  { value: 'churned_customer', label: 'Churned' },
  { value: 'colleague', label: 'Colleague' },
  { value: 'vendor', label: 'Vendor' },
  { value: 'personal', label: 'Personal' },
  { value: 'recruiter', label: 'Recruiter' },
  { value: 'newsletter', label: 'Newsletter' },
  { value: 'automated', label: 'Automated' },
  { value: 'unknown', label: 'Unknown' },
];

function contactTypeLabel(t: string | null | undefined): string {
  if (!t) return 'Unclassified';
  return CONTACT_TYPE_OPTIONS.find(o => o.value === t)?.label || t;
}

const PAGE_SIZE = 50;

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

/**
 * Percentage of num/den, rounded and clamped to [0, 100]. Guards against a zero
 * denominator and against ratios > 1 (e.g. an email opened more times than it
 * was received) so the label never reads "105%" and the bar never overflows.
 */
const clampedPct = (num: number, den: number): number =>
  den > 0 ? Math.min(100, Math.max(0, Math.round((num / den) * 100))) : 0;

export function Contacts({ onSearchMail }: { onSearchMail?: (query: string) => void } = {}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [sortBy, setSortBy] = useState<string>('relevance');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [typeFilter, setTypeFilter] = useState<string>(''); // '' = all
  const [senderStats, setSenderStats] = useState<{
    receivedCount: number;
    readCount: number;
    deletedCount: number;
    repliedCount: number;
    sentToCount: number;
    isVip: boolean;
    isBlocked: boolean;
  } | null>(null);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  // Enrichment state — in-flight flag + optional error, reused for both
  // the on-demand Enrich button and background-crawler refreshes.
  const [enriching, setEnriching] = useState(false);
  const [enrichError, setEnrichError] = useState<string | null>(null);
  const [relatedContacts, setRelatedContacts] = useState<Contact[]>([]);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.contacts.list({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        search: searchQuery || undefined,
        sortBy,
        sortOrder,
        contactType: typeFilter || undefined,
      });

      if (result.success && result.data) {
        setContacts(result.data.contacts);
        setTotal(result.data.total);
      }
    } catch (error) {
      console.error('Failed to load contacts:', error);
    } finally {
      setLoading(false);
    }
  }, [page, searchQuery, sortBy, sortOrder, typeFilter]);

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  // Listen for sidebar "Contacts" icon clicks — even when already on the
  // Contacts section — to drop back to the overview.
  useEffect(() => {
    const handler = () => setSelectedContact(null);
    document.addEventListener('sarvinbox:contacts-home', handler);
    return () => document.removeEventListener('sarvinbox:contacts-home', handler);
  }, []);

  // Refresh the list live when a contact gets enriched (name/company/phone).
  useEffect(() => {
    const handler = () => { void loadContacts(); };
    document.addEventListener('sarvinbox:contact-enriched', handler);
    return () => document.removeEventListener('sarvinbox:contact-enriched', handler);
  }, [loadContacts]);

  // Background avatar discovery found candidate photo(s) → refresh the list and
  // the open contact so the "use this photo?" prompt appears without a reload.
  useEffect(() => {
    const off = window.electronAPI.contacts.onAvatarsUpdated?.(() => {
      void loadContacts();
      setSelectedContact((prev) => {
        if (!prev) return prev;
        window.electronAPI.contacts.get(prev.id).then((res) => {
          if (res?.success && res.data) setSelectedContact(res.data);
        }).catch(() => {});
        return prev;
      });
    });
    return () => { off?.(); };
  }, [loadContacts]);

  // Fetch sender stats when a contact is selected
  useEffect(() => {
    if (!selectedContact) {
      setSenderStats(null);
      setNotes([]);
      return;
    }
    window.electronAPI.sender.getStats(selectedContact.email).then((result) => {
      if (result.success && result.data) {
        setSenderStats({
          receivedCount: result.data.receivedCount || 0,
          readCount: result.data.readCount || 0,
          deletedCount: result.data.deletedCount || 0,
          repliedCount: result.data.repliedCount || 0,
          sentToCount: result.data.sentToCount || 0,
          isVip: result.data.isVip || false,
          isBlocked: result.data.isBlocked || false,
        });
      } else {
        setSenderStats(null);
      }
    }).catch(() => setSenderStats(null));
    // Load agent-maintained memory notes for this contact (fed into the
    // LLM prompt on every categorization of their new emails).
    const anyApi = (window as any).electronAPI;
    anyApi.agent?.getNotes?.(selectedContact.email, 100).then((res: any) => {
      if (res?.success && Array.isArray(res.data)) {
        setNotes(res.data);
      } else {
        setNotes([]);
      }
    }).catch(() => setNotes([]));
  }, [selectedContact?.id, selectedContact?.email]);

  const refreshNotes = useCallback(async () => {
    if (!selectedContact) return;
    const anyApi = (window as any).electronAPI;
    const res = await anyApi.agent?.getNotes?.(selectedContact.email, 100);
    if (res?.success && Array.isArray(res.data)) setNotes(res.data);
  }, [selectedContact?.email]);

  const handleAddNote = async () => {
    if (!selectedContact || !newNote.trim()) return;
    const anyApi = (window as any).electronAPI;
    const res = await anyApi.agent?.addNote?.(selectedContact.email, newNote.trim(), 'user');
    if (res?.success) {
      setNewNote('');
      refreshNotes();
    }
  };

  const handleEditNote = async (id: number) => {
    if (!editingNoteText.trim()) {
      setEditingNoteId(null);
      return;
    }
    const anyApi = (window as any).electronAPI;
    const res = await anyApi.agent?.editNote?.(id, editingNoteText.trim());
    if (res?.success) {
      setEditingNoteId(null);
      setEditingNoteText('');
      refreshNotes();
    }
  };

  const handleDeleteNote = async (id: number) => {
    const anyApi = (window as any).electronAPI;
    const res = await anyApi.agent?.deleteNote?.(id);
    if (res?.success) refreshNotes();
  };

  // Load the "also known as" list whenever selection changes. Same
  // person_id = same human across different employer emails.
  useEffect(() => {
    if (!selectedContact) {
      setRelatedContacts([]);
      setEnrichError(null);
      return;
    }
    const anyApi = (window as any).electronAPI;
    anyApi.contacts?.getRelatedByPerson?.(selectedContact.id).then((res: any) => {
      if (res?.success && Array.isArray(res.data)) setRelatedContacts(res.data);
      else setRelatedContacts([]);
    }).catch(() => setRelatedContacts([]));
  }, [selectedContact?.id]);

  const handleEnrich = async () => {
    if (!selectedContact || enriching) return;
    setEnriching(true);
    setEnrichError(null);
    try {
      const result = await enrichContact({
        contactId: selectedContact.id,
        force: true, // button click bypasses the 90d cadence gate
      });
      if (!result.ok) {
        const messages: Record<string, string> = {
          no_contact: 'Contact not found',
          no_provider: 'Configure an AI provider in Settings → AI first',
          no_inbound_mail: 'No incoming emails from this contact to scan',
          no_signals: 'No phone/LinkedIn/company signals found in their emails',
          llm_failed: 'AI call failed',
          cadence_not_due: 'Already enriched recently',
        };
        setEnrichError(messages[result.reason] || result.reason);
      } else {
        // Pull the fresh contact row so the UI reflects the new blob
        // + any mirrored title/organization/phone columns.
        const fresh = await window.electronAPI.contacts.get(selectedContact.id);
        if (fresh.success && fresh.data) {
          setSelectedContact(fresh.data);
          setContacts((prev) => prev.map((c) => (c.id === fresh.data.id ? fresh.data : c)));
        }
      }
    } catch (err) {
      setEnrichError((err as Error).message);
    } finally {
      setEnriching(false);
    }
  };

  const handleChangeContactType = async (type: string) => {
    if (!selectedContact) return;
    const anyApi = (window as any).electronAPI;
    await anyApi.agent?.setContactType?.(selectedContact.email, type, 'user');
    // Optimistic update — parent list + detail both reflect the change
    setContacts(contacts.map(c =>
      c.id === selectedContact.id ? { ...c, contactType: type, contactTypeSource: 'user' } : c
    ));
    setSelectedContact({ ...selectedContact, contactType: type, contactTypeSource: 'user' });
  };

  const handleScan = async () => {
    setScanning(true);
    try {
      const result = await window.electronAPI.contacts.scan();
      if (result.success) {
        await loadContacts();
      }
    } catch (error) {
      console.error('Failed to scan contacts:', error);
    } finally {
      setScanning(false);
    }
  };

  // Confirm-gated avatar: the user approving/declining a discovered photo.
  // Reflect the new status locally (list + detail) so the prompt clears at once.
  const applyAvatarDecision = (contactId: string, status: 'confirmed' | 'rejected') => {
    const patch = (c: Contact): Contact =>
      c.id === contactId
        ? { ...c, avatarStatus: status, avatarUrl: status === 'rejected' ? null : c.avatarUrl }
        : c;
    setContacts((prev) => prev.map(patch));
    setSelectedContact((prev) => (prev && prev.id === contactId ? patch(prev) : prev));
  };

  const handleConfirmAvatar = async (contact: Contact) => {
    applyAvatarDecision(contact.id, 'confirmed');
    try { await window.electronAPI.contacts.confirmAvatar?.(contact.id); }
    catch (error) { console.error('Failed to confirm avatar:', error); }
  };

  const handleRejectAvatar = async (contact: Contact) => {
    applyAvatarDecision(contact.id, 'rejected');
    try { await window.electronAPI.contacts.rejectAvatar?.(contact.id); }
    catch (error) { console.error('Failed to reject avatar:', error); }
  };

  const handleToggleFavorite = async (contact: Contact) => {
    try {
      const result = await window.electronAPI.contacts.update(contact.id, {
        isFavorite: !contact.isFavorite,
      });
      if (result.success) {
        setContacts(contacts.map(c =>
          c.id === contact.id ? { ...c, isFavorite: !c.isFavorite } : c
        ));
        if (selectedContact?.id === contact.id) {
          setSelectedContact({ ...selectedContact, isFavorite: !selectedContact.isFavorite });
        }
      }
    } catch (error) {
      console.error('Failed to toggle favorite:', error);
    }
  };

  const handleDelete = async (contact: Contact) => {
    if (!confirm(`Delete contact "${contact.name || contact.email}"?`)) {
      return;
    }

    try {
      const result = await window.electronAPI.contacts.delete(contact.id);
      if (result.success) {
        setContacts(contacts.filter(c => c.id !== contact.id));
        if (selectedContact?.id === contact.id) {
          setSelectedContact(null);
        }
        setTotal(t => t - 1);
      }
    } catch (error) {
      console.error('Failed to delete contact:', error);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="flex flex-1 h-full">
      {/* Contact List */}
      <div className="w-80 border-r border-border flex flex-col bg-card">
        {/* Header */}
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Contacts</h2>
            <button
              onClick={handleScan}
              disabled={scanning}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
              title="Scan emails to discover contacts"
            >
              {scanning ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Scan
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(0);
              }}
              placeholder="Search contacts..."
              className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Sort */}
          <div className="flex items-center gap-2 mt-2">
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="flex-1 px-2 py-1 bg-background border border-border rounded text-xs"
            >
              <option value="relevance">Relevance</option>
              <option value="lastSeen">Last Activity</option>
              <option value="emailCount">Email Count</option>
              <option value="name">Name</option>
              <option value="email">Email</option>
            </select>
            <button
              onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
              className="px-2 py-1 bg-background border border-border rounded text-xs"
            >
              {sortOrder === 'asc' ? 'A-Z' : 'Z-A'}
            </button>
          </div>

          {/* Type filter — agent classification, same contact_type column */}
          <div className="flex items-center gap-2 mt-2">
            <Tag className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            <select
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value); setPage(0); }}
              className="flex-1 px-2 py-1 bg-background border border-border rounded text-xs"
            >
              <option value="">All types</option>
              {CONTACT_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {typeFilter && (
              <button
                onClick={() => { setTypeFilter(''); setPage(0); }}
                className="px-2 py-1 bg-background border border-border rounded text-xs hover:bg-accent"
                title="Clear filter"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* Contact List */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : contacts.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <User className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p className="text-sm">No contacts found</p>
              <p className="text-xs mt-1">Click "Scan" to discover contacts from your emails</p>
            </div>
          ) : (
            <div>
              {contacts.map((contact) => (
                <button
                  key={contact.id}
                  onClick={() => setSelectedContact(contact)}
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-accent/50 transition-colors ${
                    selectedContact?.id === contact.id ? 'bg-accent' : ''
                  }`}
                >
                  {/* Avatar: colored initials + Gravatar photo when available */}
                  <Avatar email={contact.email} name={formatDisplayName(contact)} size={40} photoUrl={contact.avatarStatus === 'confirmed' ? contact.avatarUrl : null} />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">
                        {formatDisplayName(contact)}
                      </span>
                      {contact.isFavorite && (
                        <Star className="h-3 w-3 text-yellow-500 fill-yellow-500 flex-shrink-0" />
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {contact.email}
                    </div>
                  </div>

                  {/* Email count badge */}
                  <div className="flex items-center gap-1">
                    <div className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {contact.emailCount}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="p-3 border-t border-border flex items-center justify-between">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1 hover:bg-accent rounded disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-xs text-muted-foreground">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-1 hover:bg-accent rounded disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Total count */}
        <div className="px-4 py-2 border-t border-border text-xs text-muted-foreground text-center">
          {total} contacts
        </div>
      </div>

      {/* Contact Detail or Dashboard */}
      <div className="flex-1 bg-background">
        {!selectedContact && (
          <ContactsDashboard
            onSelectContact={(c) => setSelectedContact(c)}
            contactsVersion={contacts.length + ':' + total}
          />
        )}
        {selectedContact && (
          <div className="h-full flex flex-col">
            {/* Header */}
            <div className="p-6 border-b border-border">
              <div className="flex items-start gap-4">
                {/* Large avatar: colored initials + Gravatar photo when available */}
                <Avatar email={selectedContact.email} name={formatDisplayName(selectedContact)} size={80} photoUrl={selectedContact.avatarStatus === 'confirmed' ? selectedContact.avatarUrl : null} />

                {/* Info */}
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-semibold">
                      {formatDisplayName(selectedContact)}
                    </h2>
                    <Tooltip content={selectedContact.isFavorite ? 'Remove from favorites' : 'Add to favorites'} delayMs={40}>
                      <button
                        onClick={() => handleToggleFavorite(selectedContact)}
                        aria-label={selectedContact.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                        className="p-1 hover:bg-accent rounded"
                      >
                        {selectedContact.isFavorite ? (
                          <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
                        ) : (
                          <Star className="h-5 w-5 text-muted-foreground" />
                        )}
                      </button>
                    </Tooltip>
                  </div>

                  {selectedContact.title && selectedContact.organization && (
                    <p className="text-muted-foreground mt-1">
                      {selectedContact.title} at {selectedContact.organization}
                    </p>
                  )}

                  {/* Contact type — agent-classified or user-edited, same `contacts.contact_type` column */}
                  <div className="flex items-center gap-2 mt-3">
                    <Tag className="h-4 w-4 text-muted-foreground" />
                    <select
                      value={selectedContact.contactType || 'unknown'}
                      onChange={(e) => handleChangeContactType(e.target.value)}
                      className="text-xs bg-background border border-input rounded-md px-2 py-1"
                    >
                      {CONTACT_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                    {selectedContact.contactTypeSource && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded-full">
                        {selectedContact.contactTypeSource}
                        {typeof selectedContact.contactTypeConfidence === 'number' && selectedContact.contactTypeConfidence > 0 && (
                          <> · {Math.round(selectedContact.contactTypeConfidence * 100)}%</>
                        )}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-4 mt-3">
                    <button
                      onClick={handleEnrich}
                      disabled={enriching}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
                      title="Scan recent emails and extract LinkedIn, phone, designation, company info"
                    >
                      {enriching ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                      {enriching ? 'Enriching…' : 'Enrich'}
                    </button>
                    <button
                      onClick={() => handleDelete(selectedContact)}
                      className="flex items-center gap-1 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 rounded"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </button>
                  </div>
                  {enrichError && (
                    <p className="mt-2 text-xs text-destructive">{enrichError}</p>
                  )}
                </div>
              </div>
            </div>

            {/* A discovered photo awaiting the user's confirmation. Shown only
                in the detail pane (never as noise in the list). Approve → it
                becomes this contact's avatar; decline → keep initials. */}
            {selectedContact.avatarStatus === 'pending' && selectedContact.avatarUrl && (
              <div className="mx-6 mt-4 flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
                <img
                  src={selectedContact.avatarUrl}
                  alt=""
                  className="h-12 w-12 flex-shrink-0 rounded-full object-cover"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">We found a photo for this contact</div>
                  <div className="text-xs text-muted-foreground">Use it as their avatar?</div>
                </div>
                <button
                  onClick={() => handleConfirmAvatar(selectedContact)}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Use photo
                </button>
                <button
                  onClick={() => handleRejectAvatar(selectedContact)}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent"
                >
                  Keep initials
                </button>
              </div>
            )}

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              <div className="grid grid-cols-2 gap-6">
                {/* Contact Info */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                    Contact Information
                  </h3>

                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      {/* Opens Mail filtered to this address. Composing a new
                          message is the less common intent from a contact card —
                          "show me our correspondence" is — so the click searches
                          and the mailto: stays available via the mail icon. */}
                      <button
                        type="button"
                        onClick={() => onSearchMail?.(selectedContact.email)}
                        disabled={!onSearchMail}
                        title={`Show emails from ${selectedContact.email}`}
                        className="text-sm text-primary hover:underline disabled:no-underline disabled:cursor-default"
                      >
                        {selectedContact.email}
                      </button>
                    </div>

                    {(() => {
                      // Prefer the LLM-classified personal/mobile number over
                      // selectedContact.phone — the raw column is populated
                      // from signature scraping and frequently lands on the
                      // office/toll-free line, which is misleading next to
                      // the contact's name. Fall back to the raw phone only
                      // when enrichment hasn't found a personal/mobile yet.
                      const personal =
                        selectedContact.enrichment?.personalPhone ||
                        selectedContact.enrichment?.whatsappNumber ||
                        selectedContact.mobileE164 ||
                        null;
                      const office = selectedContact.enrichment?.companyPhone || null;
                      const display = personal || office || selectedContact.phone || null;
                      if (!display) return null;
                      // With no personal/mobile number, the only number we have is
                      // the shared office line — label it so it isn't read as the
                      // contact's own number.
                      const isOffice = !personal;
                      return (
                        <div className="flex items-center gap-3">
                          <Phone className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm">
                            {formatPhone(display)}
                            {isOffice && <span className="text-xs text-muted-foreground ml-1">(office)</span>}
                          </span>
                        </div>
                      );
                    })()}

                    {selectedContact.organization && (
                      <div className="flex items-center gap-3">
                        <Building className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">{selectedContact.organization}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Activity Stats */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                    Email Activity
                  </h3>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">Total Emails</span>
                      </div>
                      <span className="text-sm font-medium">{selectedContact.emailCount}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Inbox className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">Received</span>
                      </div>
                      <span className="text-sm font-medium">{selectedContact.receivedCount}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Send className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">Sent</span>
                      </div>
                      <span className="text-sm font-medium">{selectedContact.sentCount}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">First Contact</span>
                      </div>
                      <span className="text-sm">{formatDate(selectedContact.firstSeen)}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Calendar className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">Last Activity</span>
                      </div>
                      <span className="text-sm">{formatDate(selectedContact.lastSeen)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Engagement Metrics */}
              {senderStats && senderStats.receivedCount > 0 && (
                <div className="mt-6 space-y-4">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                    Engagement Metrics
                  </h3>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Read % */}
                    {(() => {
                      const readPct = clampedPct(senderStats.readCount, senderStats.receivedCount);
                      const readColor = readPct >= 70 ? 'bg-green-500' : readPct >= 30 ? 'bg-yellow-500' : 'bg-red-500';
                      return (
                        <div className="p-3 bg-card border border-border rounded-lg">
                          <div className="flex items-center gap-2 mb-2">
                            <Eye className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">Read %</span>
                            <span className="ml-auto text-lg font-bold">{readPct}%</span>
                          </div>
                          <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                            <div className={`h-2 rounded-full ${readColor}`} style={{ width: `${readPct}%` }} />
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {senderStats.readCount} opened of {senderStats.receivedCount} received
                          </p>
                        </div>
                      );
                    })()}

                    {/* Keep % */}
                    {(() => {
                      const keepPct = clampedPct(senderStats.receivedCount - senderStats.deletedCount, senderStats.receivedCount);
                      const keepColor = keepPct >= 70 ? 'bg-green-500' : keepPct >= 30 ? 'bg-yellow-500' : 'bg-red-500';
                      return (
                        <div className="p-3 bg-card border border-border rounded-lg">
                          <div className="flex items-center gap-2 mb-2">
                            <Archive className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">Keep %</span>
                            <span className="ml-auto text-lg font-bold">{keepPct}%</span>
                          </div>
                          <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                            <div className={`h-2 rounded-full ${keepColor}`} style={{ width: `${keepPct}%` }} />
                          </div>
                          <p className="text-xs text-muted-foreground mt-1">
                            {senderStats.receivedCount - senderStats.deletedCount} kept of {senderStats.receivedCount} received
                          </p>
                        </div>
                      );
                    })()}
                  </div>
                </div>
              )}

              {/* Enrichment — LinkedIn / social / phones / designation
                  mined from email signatures. Rendered only when we
                  have something to show. */}
              {selectedContact.enrichment && (
                <div className="mt-6 space-y-3">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                    <Sparkles className="h-4 w-4" />
                    Enrichment
                    {selectedContact.enrichmentSource && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded-full normal-case font-normal tracking-normal">
                        {selectedContact.enrichmentSource}
                      </span>
                    )}
                  </h3>

                  <div className="grid grid-cols-2 gap-4">
                    {/* Role */}
                    {(selectedContact.enrichment.designation || selectedContact.enrichment.department) && (
                      <div className="flex items-start gap-3">
                        <Briefcase className="h-4 w-4 text-muted-foreground mt-0.5" />
                        <div className="text-sm">
                          {selectedContact.enrichment.designation && <div>{selectedContact.enrichment.designation}</div>}
                          {selectedContact.enrichment.department && (
                            <div className="text-xs text-muted-foreground">{selectedContact.enrichment.department}</div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Company */}
                    {(selectedContact.enrichment.companyName || selectedContact.enrichment.companyDomain) && (
                      <div className="flex items-start gap-3">
                        <Building className="h-4 w-4 text-muted-foreground mt-0.5" />
                        <div className="text-sm">
                          <div>{selectedContact.enrichment.companyName || selectedContact.enrichment.companyDomain}</div>
                          {selectedContact.enrichment.companyWebsite && (
                            <a
                              href={selectedContact.enrichment.companyWebsite}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                            >
                              {selectedContact.enrichment.companyDomain || selectedContact.enrichment.companyWebsite}
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Personal phone / WhatsApp */}
                    {(selectedContact.enrichment.personalPhone || selectedContact.enrichment.whatsappNumber) && (
                      <div className="flex items-center gap-3">
                        <Phone className="h-4 w-4 text-muted-foreground" />
                        <div className="text-sm">
                          {selectedContact.enrichment.personalPhone && <div>{formatPhone(selectedContact.enrichment.personalPhone)} <span className="text-xs text-muted-foreground">(personal)</span></div>}
                          {selectedContact.enrichment.whatsappNumber && selectedContact.enrichment.whatsappNumber !== selectedContact.enrichment.personalPhone && (
                            <div>{formatPhone(selectedContact.enrichment.whatsappNumber)} <span className="text-xs text-muted-foreground">(whatsapp)</span></div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Company phone */}
                    {selectedContact.enrichment.companyPhone && (
                      <div className="flex items-center gap-3">
                        <Phone className="h-4 w-4 text-muted-foreground" />
                        <div className="text-sm">
                          {formatPhone(selectedContact.enrichment.companyPhone)} <span className="text-xs text-muted-foreground">(office)</span>
                        </div>
                      </div>
                    )}

                    {/* Location */}
                    {selectedContact.enrichment.location && (
                      <div className="flex items-center gap-3">
                        <MapPin className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">{selectedContact.enrichment.location}</span>
                      </div>
                    )}

                    {/* Personal email */}
                    {selectedContact.enrichment.personalEmail && (
                      <div className="flex items-center gap-3">
                        <Mail className="h-4 w-4 text-muted-foreground" />
                        <a href={`mailto:${selectedContact.enrichment.personalEmail}`} className="text-sm text-primary hover:underline">
                          {selectedContact.enrichment.personalEmail}
                        </a>
                      </div>
                    )}
                  </div>

                  {/* Social icons */}
                  {(selectedContact.enrichment.linkedinUrl ||
                    selectedContact.enrichment.twitterUrl ||
                    selectedContact.enrichment.githubUrl ||
                    (selectedContact.enrichment.otherSocials && selectedContact.enrichment.otherSocials.length > 0)) && (
                    <div className="flex items-center gap-2 pt-2">
                      {selectedContact.enrichment.linkedinUrl && (
                        <a
                          href={selectedContact.enrichment.linkedinUrl}
                          target="_blank" rel="noreferrer"
                          className="p-2 rounded-md border border-border hover:bg-accent"
                          title={selectedContact.enrichment.linkedinUrl}
                        >
                          <Linkedin className="h-4 w-4" />
                        </a>
                      )}
                      {selectedContact.enrichment.twitterUrl && (
                        <a
                          href={selectedContact.enrichment.twitterUrl}
                          target="_blank" rel="noreferrer"
                          className="p-2 rounded-md border border-border hover:bg-accent"
                          title={selectedContact.enrichment.twitterUrl}
                        >
                          <Twitter className="h-4 w-4" />
                        </a>
                      )}
                      {selectedContact.enrichment.githubUrl && (
                        <a
                          href={selectedContact.enrichment.githubUrl}
                          target="_blank" rel="noreferrer"
                          className="p-2 rounded-md border border-border hover:bg-accent"
                          title={selectedContact.enrichment.githubUrl}
                        >
                          <Github className="h-4 w-4" />
                        </a>
                      )}
                      {selectedContact.enrichment.otherSocials?.map((s) => (
                        <a
                          key={s.url}
                          href={s.url}
                          target="_blank" rel="noreferrer"
                          className="px-2 py-1 rounded-md border border-border hover:bg-accent text-xs inline-flex items-center gap-1"
                          title={s.url}
                        >
                          <Globe className="h-3 w-3" />
                          {s.platform}
                        </a>
                      ))}
                    </div>
                  )}

                  {/* Also known as — same person_id across emails */}
                  {relatedContacts.length > 0 && (
                    <div className="pt-2">
                      <div className="text-xs text-muted-foreground mb-1">Also known as (same person)</div>
                      <div className="flex flex-wrap gap-1.5">
                        {relatedContacts.map((rc) => (
                          <button
                            key={rc.id}
                            onClick={() => setSelectedContact(rc)}
                            className="text-xs px-2 py-1 rounded-md border border-border hover:bg-accent"
                            title={rc.email}
                          >
                            {rc.email}
                            {rc.organization ? ` · ${rc.organization}` : ''}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedContact.enrichment.notes && (
                    <p className="text-xs text-muted-foreground italic pt-1">{selectedContact.enrichment.notes}</p>
                  )}
                </div>
              )}

              {/* Memory (agent notes) — one-line pointers about this contact
                  that the agent extracts from past conversations and feeds
                  back into the LLM prompt when their new emails arrive.
                  Editable here; changes take effect on the next categorization run. */}
              <div className="mt-6">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
                    <StickyNote className="h-4 w-4" />
                    Memory ({notes.length})
                  </h3>
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  One-line pointers the agent remembers about this contact. Sent back to the LLM as context when their new emails arrive.
                </p>

                {/* Add new */}
                <div className="flex items-center gap-2 mb-3">
                  <input
                    type="text"
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleAddNote(); }}
                    placeholder="Add a memory pointer (e.g. 'prefers morning meetings', 'asked about pricing in Jan')"
                    className="flex-1 px-3 py-1.5 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <button
                    onClick={handleAddNote}
                    disabled={!newNote.trim()}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add
                  </button>
                </div>

                {notes.length === 0 ? (
                  <div className="p-4 bg-muted/30 border border-dashed border-border rounded-lg text-sm text-muted-foreground text-center">
                    No memory yet. Add a pointer or let the agent extract one from a conversation.
                  </div>
                ) : (
                  <div className="space-y-1">
                    {notes.map((n) => (
                      <div key={n.id} className="flex items-center gap-2 p-2 rounded-lg border border-border hover:bg-accent/30 transition-colors">
                        {editingNoteId === n.id ? (
                          <>
                            <input
                              type="text"
                              value={editingNoteText}
                              onChange={(e) => setEditingNoteText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleEditNote(n.id);
                                if (e.key === 'Escape') { setEditingNoteId(null); setEditingNoteText(''); }
                              }}
                              autoFocus
                              className="flex-1 px-2 py-1 bg-background border border-border rounded text-sm outline-none focus:ring-2 focus:ring-primary/50"
                            />
                            <button
                              onClick={() => handleEditNote(n.id)}
                              className="p-1 text-green-600 hover:bg-green-500/10 rounded"
                              title="Save"
                            >
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => { setEditingNoteId(null); setEditingNoteText(''); }}
                              className="p-1 text-muted-foreground hover:bg-accent rounded"
                              title="Cancel"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </>
                        ) : (
                          <>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm">{n.note}</div>
                              <div className="text-[10px] text-muted-foreground">
                                {n.category || 'general'} · {new Date(n.createdAt * 1000).toLocaleDateString()}
                              </div>
                            </div>
                            <button
                              onClick={() => { setEditingNoteId(n.id); setEditingNoteText(n.note); }}
                              className="p-1 text-muted-foreground hover:bg-accent rounded"
                              title="Edit"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteNote(n.id)}
                              className="p-1 text-destructive hover:bg-destructive/10 rounded"
                              title="Delete"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Notes (free-text user notes on the contact itself — distinct
                  from agent memory above which is per-conversation one-liners) */}
              {selectedContact.notes && (
                <div className="mt-6">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Notes
                  </h3>
                  <p className="text-sm whitespace-pre-wrap">{selectedContact.notes}</p>
                </div>
              )}

              {/* Tags */}
              {selectedContact.tags && selectedContact.tags.length > 0 && (
                <div className="mt-6">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    Tags
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {selectedContact.tags.map((tag, i) => (
                      <span
                        key={i}
                        className="px-2 py-1 bg-accent text-accent-foreground rounded text-xs"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ========== Contacts Dashboard ==========
//
// Shown when no contact is selected. Gives an at-a-glance view across
// the whole address book: counts by agent classification, most-active
// senders, and most-recent contacts. All rendered off the same
// `contacts` table that powers the list + detail panels (single source
// of truth — no separate dashboard store).

function ContactsDashboard({
  onSelectContact,
  contactsVersion,
}: {
  onSelectContact: (c: Contact) => void;
  contactsVersion: string;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [topActive, setTopActive] = useState<Contact[]>([]);
  const [recent, setRecent] = useState<Contact[]>([]);
  const [vips, setVips] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [classifying, setClassifying] = useState(false);
  const [classifyError, setClassifyError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const handleAutoClassify = async () => {
    const userEmail = localStorage.getItem('sarvinbox-user-email')
      || (() => {
        try {
          const settings = JSON.parse(localStorage.getItem('sarvinbox-settings') || '{}');
          return settings.profileEmail || '';
        } catch { return ''; }
      })();
    if (!userEmail) {
      setClassifyError('Set your email in Settings → Profile first.');
      return;
    }
    setClassifying(true);
    setClassifyError(null);
    try {
      const anyApi = (window as any).electronAPI;
      const res = await anyApi.agent?.autoClassifyContacts?.(userEmail);
      if (res?.success) {
        // Reload the dashboard so the tile counts and "unclassified" nudge
        // reflect the just-classified rows.
        setReloadKey(k => k + 1);
      } else {
        setClassifyError(res?.error || 'Auto-classify failed.');
      }
    } catch (err) {
      setClassifyError((err as Error).message);
    } finally {
      setClassifying(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const anyApi = (window as any).electronAPI;
        const [countsRes, topRes, recentRes, listRes] = await Promise.all([
          anyApi.agent?.getContactTypeCounts?.() ?? Promise.resolve({ success: false }),
          window.electronAPI.contacts.list({ limit: 8, offset: 0, sortBy: 'emailCount', sortOrder: 'desc' }),
          window.electronAPI.contacts.list({ limit: 8, offset: 0, sortBy: 'lastSeen', sortOrder: 'desc' }),
          window.electronAPI.contacts.list({ limit: 1, offset: 0 }),
        ]);
        if (cancelled) return;
        if (countsRes?.success && countsRes.data) setCounts(countsRes.data);
        if (topRes?.success && topRes.data) setTopActive(topRes.data.contacts || []);
        if (recentRes?.success && recentRes.data) setRecent(recentRes.data.contacts || []);
        if (listRes?.success && listRes.data) setTotal(listRes.data.total || 0);
        // VIPs: pull via sender.listVip then hydrate against contacts list.
        const vipRes = await anyApi.sender?.listVip?.();
        if (vipRes?.success && Array.isArray(vipRes.data) && vipRes.data.length > 0) {
          // sender.listVip returns sender_stats rows — just need email to render.
          // Map to a light Contact-shaped object for the tile; full data
          // comes when user clicks through.
          const simplified: Contact[] = vipRes.data.slice(0, 8).map((s: any) => ({
            id: s.email,
            email: s.email,
            name: null, displayName: null, avatarUrl: null,
            organization: null, title: null, phone: null,
            firstSeen: s.firstSeen || 0, lastSeen: s.lastReceived || 0,
            emailCount: s.receivedCount || 0,
            sentCount: s.sentToCount || 0,
            receivedCount: s.receivedCount || 0,
            isFavorite: true, notes: null, tags: [],
            createdAt: s.createdAt || 0, updatedAt: s.updatedAt || 0,
          }));
          if (!cancelled) setVips(simplified);
        } else {
          setVips([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [contactsVersion, reloadKey]);

  // Classification tile order — same taxonomy as CONTACT_TYPE_OPTIONS
  const typeOrder: Array<{ key: string; label: string; tone: string }> = [
    { key: 'existing_customer', label: 'Customers', tone: 'text-green-600 bg-green-500/10' },
    { key: 'potential_customer', label: 'Prospects', tone: 'text-blue-600 bg-blue-500/10' },
    { key: 'colleague', label: 'Colleagues', tone: 'text-cyan-600 bg-cyan-500/10' },
    { key: 'vendor', label: 'Vendors', tone: 'text-purple-600 bg-purple-500/10' },
    { key: 'newsletter', label: 'Newsletters', tone: 'text-gray-500 bg-gray-500/10' },
    { key: 'unknown', label: 'Unclassified', tone: 'text-muted-foreground bg-muted' },
  ];

  const classified = Object.entries(counts).filter(([k]) => k !== 'unknown').reduce((a, [, n]) => a + n, 0);
  const unclassified = counts['unknown'] || 0;
  const classifiedPct = total > 0 ? Math.round((classified / total) * 100) : 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Contacts overview</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {total.toLocaleString()} contacts · {classifiedPct}% classified · Data lives in one table shared with the agent.
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : total === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-12 text-center text-muted-foreground">
            <User className="h-12 w-12 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No contacts yet. Click "Scan" in the sidebar to discover contacts from your emails.</p>
          </div>
        ) : (
          <>
            {/* Classification tiles */}
            <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
              {typeOrder.map(({ key, label, tone }) => {
                const n = key === 'unknown' ? unclassified : (counts[key] || 0);
                return (
                  <div key={key} className={`rounded-lg border border-border p-3 ${n === 0 ? 'opacity-50' : ''}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <Tag className={`h-3.5 w-3.5 ${tone.split(' ')[0]}`} />
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
                    </div>
                    <div className="text-2xl font-semibold">{n.toLocaleString()}</div>
                  </div>
                );
              })}
            </div>

            {/* Two-column: Top Active + Recently Active */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ContactListCard
                title="Most active"
                subtitle="Highest email count"
                icon={<Mail className="h-4 w-4 text-primary" />}
                contacts={topActive}
                metric={(c) => `${c.emailCount} emails`}
                onSelect={onSelectContact}
              />
              <ContactListCard
                title="Recently active"
                subtitle="Last email received or sent"
                icon={<Calendar className="h-4 w-4 text-primary" />}
                contacts={recent}
                metric={(c) => new Date(c.lastSeen * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                onSelect={onSelectContact}
              />
            </div>

            {/* VIPs row (only if user has marked any) */}
            {vips.length > 0 && (
              <ContactListCard
                title="VIPs"
                subtitle="Marked as VIP on sender_stats"
                icon={<Star className="h-4 w-4 text-yellow-500" />}
                contacts={vips}
                metric={(c) => `${c.emailCount} emails`}
                onSelect={onSelectContact}
              />
            )}

            {/* Unclassified nudge */}
            {unclassified > 0 && classifiedPct < 80 && (
              <div className="p-4 rounded-lg border border-yellow-500/20 bg-yellow-500/5 text-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="font-medium text-yellow-700 dark:text-yellow-400">
                      {unclassified} contacts still unclassified
                    </div>
                    <div className="text-muted-foreground mt-1">
                      Run Auto-Classify to assign a contact type using the agent's heuristics, or edit each contact's type from their detail view.
                    </div>
                    {classifyError && (
                      <div className="mt-2 text-xs text-destructive">{classifyError}</div>
                    )}
                  </div>
                  <button
                    onClick={handleAutoClassify}
                    disabled={classifying}
                    className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 transition-colors"
                  >
                    {classifying ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {classifying ? 'Classifying...' : 'Auto-Classify'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ContactListCard({
  title,
  subtitle,
  icon,
  contacts,
  metric,
  onSelect,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  contacts: Contact[];
  metric: (c: Contact) => string;
  onSelect: (c: Contact) => void;
}) {
  return (
    <div className="rounded-lg border border-border">
      <div className="px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-sm font-medium">{title}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>
      </div>
      <div className="divide-y divide-border">
        {contacts.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">No contacts</div>
        ) : (
          contacts.map((c) => (
            <button
              key={c.id}
              onClick={() => onSelect(c)}
              className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent/30 transition-colors"
            >
              <Avatar email={c.email} name={formatDisplayName(c)} size={32} photoUrl={c.avatarStatus === 'confirmed' ? c.avatarUrl : null} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium truncate">{formatDisplayName(c)}</span>
                  {c.contactType && c.contactType !== 'unknown' && (
                    <span className="text-[9px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded-full uppercase tracking-wider flex-shrink-0">
                      {contactTypeLabel(c.contactType)}
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground truncate">{c.email}</div>
              </div>
              <div className="text-xs text-muted-foreground flex-shrink-0">{metric(c)}</div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
