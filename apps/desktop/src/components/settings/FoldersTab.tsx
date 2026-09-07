import { Folder as FolderIcon, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

interface FolderRow {
  id: string;
  path: string;
  name: string;
  syncEnabled?: boolean;
  syncMode?: 'full' | 'headers' | null;
}

type FolderSyncChoice = 'full' | 'headers' | 'off';

const choiceOf = (f: FolderRow): FolderSyncChoice =>
  f.syncEnabled === false ? 'off' : f.syncMode === 'headers' ? 'headers' : 'full';

const CHOICE_LABEL: Record<FolderSyncChoice, string> = {
  full: 'Sync (full)',
  headers: 'Headers only',
  off: 'Don’t sync',
};

/**
 * Per-folder sync control. One dropdown per folder: Full / Headers only / Off.
 * "Off" stops syncing AND unsubscribes the mailbox on the server (backend). This
 * is the lever for heavy accounts — turn off folders you never read so they stop
 * consuming sync + storage. Changes apply on the next sync.
 */
export function FoldersTab() {
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI.folders.list();
      if (res?.success && res.data) setFolders(res.data as FolderRow[]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const onChange = async (folder: FolderRow, choice: FolderSyncChoice) => {
    const policy = {
      syncEnabled: choice !== 'off',
      syncMode: (choice === 'off' ? null : choice) as 'full' | 'headers' | null,
    };
    // Optimistic — reflect the choice immediately, revert on failure.
    setFolders((prev) => prev.map((f) => (f.id === folder.id ? { ...f, ...policy } : f)));
    setSavingId(folder.id);
    try {
      const res = await window.electronAPI.folders.setSyncPolicy(folder.id, policy);
      if (!res?.success) await load(); // reload authoritative state on failure
    } catch {
      await load();
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold mb-1">Folders</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Choose how each folder syncs. Turn off folders you never read to keep a large
        mailbox fast and small. <span className="font-medium">Headers only</span> lists
        messages without downloading their bodies until you open them.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading folders…
        </div>
      ) : folders.length === 0 ? (
        <div className="text-sm text-muted-foreground py-6">No folders found.</div>
      ) : (
        <div className="border border-border rounded-lg divide-y divide-border">
          {folders.map((f) => (
            <div key={f.id} className="flex items-center gap-3 px-3 py-2">
              <FolderIcon className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="flex-1 min-w-0 truncate text-sm" title={f.path}>{f.path || f.name}</span>
              {savingId === f.id && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
              <select
                value={choiceOf(f)}
                onChange={(e) => onChange(f, e.target.value as FolderSyncChoice)}
                className="text-sm rounded-md border border-border bg-background px-2 py-1"
                aria-label={`Sync setting for ${f.path || f.name}`}
              >
                {(['full', 'headers', 'off'] as FolderSyncChoice[]).map((c) => (
                  <option key={c} value={c}>{CHOICE_LABEL[c]}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
