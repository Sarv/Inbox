import { Loader2, Trash2, Plus, AlertCircle } from 'lucide-react';
import { useState, useEffect } from 'react';

import { useConfirm } from '../ConfirmDialog';
import { Pagination } from '../Pagination';
import { Tooltip } from '../Tooltip';

import type { SpammerRecord } from './types';

const DEFAULT_PAGE_SIZE = 20;

/**
 * Blocked-senders manager (backed by the `spammers` table via electronAPI).
 * Server-side paginated + searchable. Shared by the Blocked tab (and any other
 * surface that needs blocked-sender management) so there's one source of truth.
 */
export function BlockedSendersPanel() {
  const { confirm, confirmDialog } = useConfirm();
  const [spammers, setSpammers] = useState<SpammerRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const result = await window.electronAPI.spammers.list({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        search: search.trim() || undefined,
      });
      if (result.success && result.data) {
        const list = Array.isArray(result.data.spammers) ? result.data.spammers : [];
        setSpammers(list);
        setTotal(result.data.total ?? list.length);
      }
    } catch (error) {
      console.error('Failed to load blocked senders:', error);
    } finally {
      setLoading(false);
    }
  };

  // Refetch whenever the page window, page size, or search changes. `load`
  // reads the latest state on each run, so [page, pageSize, search] are the
  // only real triggers.
  useEffect(() => {
    load();
  }, [page, pageSize, search]);

  // Searching / resizing the page should always start from page 1.
  const onSearchChange = (value: string) => {
    setSearch(value);
    setPage(1);
  };
  const onPageSizeChange = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  const handleAdd = async () => {
    if (!newEmail.trim()) return;
    setAdding(true);
    try {
      const result = await window.electronAPI.spammers.add({
        email: newEmail.trim().toLowerCase(),
        name: newName.trim() || undefined,
        reason: 'Manually added in settings',
      });
      if (result.success) {
        setNewEmail('');
        setNewName('');
        // Newest sorts first — jump to page 1 to reveal it (reload if already there).
        if (page === 1) load(); else setPage(1);
      }
    } catch (error) {
      console.error('Failed to block sender:', error);
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (email: string) => {
    const ok = await confirm({
      title: 'Unblock sender',
      message: `Unblock ${email}? Future emails from this sender will no longer be auto-moved to spam.`,
      confirmLabel: 'Unblock',
    });
    if (!ok) return;
    try {
      const result = await window.electronAPI.spammers.remove(email);
      if (result.success) {
        // If we just removed the last row on a non-first page, step back a page;
        // otherwise reload the current window so totals/pagination stay correct.
        if (spammers.length === 1 && page > 1) setPage(page - 1);
        else load();
      }
    } catch (error) {
      console.error('Failed to unblock sender:', error);
    }
  };

  return (
    <div>
      {confirmDialog}
      <p className="text-sm text-muted-foreground mb-4">
        Emails from blocked senders are automatically moved to spam. When you mark an email as spam, its
        sender is added here.
      </p>

      {/* Add */}
      <div className="bg-muted/30 rounded-lg p-4 mb-4">
        <h4 className="text-sm font-medium mb-3">Block a sender</h4>
        <div className="flex gap-3">
          <input
            type="email"
            placeholder="Email address"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className="flex-1 px-3 py-2 border border-border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <input
            type="text"
            placeholder="Name (optional)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="flex-1 px-3 py-2 border border-border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <button
            onClick={handleAdd}
            disabled={!newEmail.trim() || adding}
            className="px-4 py-2 bg-destructive text-destructive-foreground rounded-md text-sm font-medium hover:bg-destructive/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Block
          </button>
        </div>
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search blocked senders..."
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        className="w-full px-3 py-2 mb-4 border border-border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
      />

      {/* List */}
      <div className="border border-border rounded-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : spammers.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <AlertCircle className="h-8 w-8 mb-2" />
            <p className="text-sm">No blocked senders</p>
            <p className="text-xs mt-1">
              {search ? 'No results match your search' : 'Mark emails as spam to block senders'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {spammers.map((spammer) => (
              <div key={spammer.email} className="flex items-center justify-between px-4 py-3 hover:bg-muted/30">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">{spammer.name || spammer.email}</span>
                    {spammer.name && (
                      <span className="text-xs text-muted-foreground truncate">({spammer.email})</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    {spammer.domain && (
                      <span className="text-xs text-muted-foreground">Domain: {spammer.domain}</span>
                    )}
                    <span className="text-xs text-muted-foreground">Reported {spammer.reportedCount}x</span>
                    <span className="text-xs text-muted-foreground">
                      Added: {new Date(spammer.firstReportedAt * 1000).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <Tooltip content="Unblock sender" delayMs={40}>
                  <button
                    onClick={() => handleRemove(spammer.email)}
                    className="ml-4 p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                    aria-label="Unblock sender"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination + total */}
      {(total > 0 || search) && (
        <div className="mt-3">
          <Pagination
            total={total}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={onPageSizeChange}
            itemLabel="blocked sender"
          />
        </div>
      )}
    </div>
  );
}
