import { Loader2, GitMerge, HardDrive } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { useConfirm } from '../ConfirmDialog';
import { formatBytes } from '../quota-format';

import { summariseCompaction } from './compaction-summary';
import { UpdatesSection } from './UpdatesSection';

interface AccountStorageUsage {
  accountId: string;
  email: string;
  host: string;
  fileBytes: number;
  freeBytes: number;
  liveBytes: number;
  freeRatio: number;
  /**
   * Set by the main process: enough wasted space, in both share and absolute
   * terms, for a rebuild to earn the minutes it costs. The button follows this
   * rather than "any free bytes at all" — see the note rendered beside it.
   */
  worthwhile: boolean;
}

type NoticeTone = 'success' | 'warning';

const NOTICE_STYLES: Record<NoticeTone, string> = {
  success:
    'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200',
  warning:
    'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200',
};

export function AdvancedTab() {
  const { confirm, confirmDialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [usage, setUsage] = useState<AccountStorageUsage[] | null>(null);
  const [compacting, setCompacting] = useState<string | null>(null);
  const [storageNotice, setStorageNotice] = useState<{ text: string; tone: NoticeTone } | null>(null);

  const loadUsage = useCallback(async () => {
    try {
      const result = await window.electronAPI.storage.getUsage();
      setUsage(result.success ? (result.data ?? []) : []);
    } catch {
      // A failed size read is not worth an error banner — the section simply
      // shows nothing rather than blocking the rest of the Advanced tab.
      setUsage([]);
    }
  }, []);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const handleRethread = async () => {
    setBusy(true);
    setNotice(null);
    try {
      // Dry run first to preview how many emails would be regrouped.
      const dry = await window.electronAPI.emails.repairThreading({ dryRun: true });
      if (!dry.success || !dry.data) {
        setNotice(`Could not scan: ${dry.error ?? 'unknown error'}`);
        return;
      }
      const n = dry.data.emailsRetargeted ?? 0;
      if (n === 0) {
        setNotice('Everything is already grouped — nothing to re-thread.');
        return;
      }
      const ok = await confirm({
        title: 'Re-thread emails',
        message: `${n} email${n === 1 ? '' : 's'} will be grouped into conversations with other emails that share the same subject and sender. This updates existing mail and can't be undone automatically. Continue?`,
        confirmLabel: 'Re-thread',
        destructive: false,
      });
      if (!ok) return;

      const applied = await window.electronAPI.emails.repairThreading({ dryRun: false });
      if (applied.success) {
        setNotice(`Regrouped ${applied.data?.emailsRetargeted ?? n} emails. Reloading…`);
        setTimeout(() => window.location.reload(), 1200);
      } else {
        setNotice(`Re-thread failed: ${applied.error ?? 'unknown error'}`);
      }
    } catch (error) {
      setNotice(`Re-thread failed: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleCompact = async (account: AccountStorageUsage) => {
    setStorageNotice(null);

    const ok = await confirm({
      title: 'Compress database',
      message:
        // Name the host here too. One address can be configured on two servers,
        // and confirming a ten-minute rebuild of the wrong database because both
        // rows read the same email is exactly the mistake this prevents.
        `Rebuild the database for ${account.email}` +
        `${account.host ? ` on ${account.host}` : ''}, reclaiming about ` +
        `${formatBytes(account.freeBytes)} of disk space.\n\n` +
        // "Compress" is a word people associate with lossy formats and with
        // things that have to be un-done before they can be used again. Say
        // plainly that neither is true here, BEFORE they commit to it.
        `Your mail is not touched. Nothing is deleted, shortened or moved to the ` +
        `server, and no attachment quality is reduced — every message, flag and ` +
        `label stays exactly as it is. All that changes is the empty space left ` +
        `behind by mail you deleted earlier, which goes back to your disk instead ` +
        `of being kept in the file.\n\n` +
        `It can take several minutes on a large mailbox. Mail sync for this account ` +
        `pauses until it finishes, and the app may be briefly unresponsive. ` +
        `Keep the app open until it completes — if it is interrupted, the original ` +
        `file is left untouched and you can simply run it again.`,
      confirmLabel: 'Compress',
      destructive: false,
    });
    if (!ok) return;

    setCompacting(account.accountId);
    try {
      const result = await window.electronAPI.storage.compact(account.accountId);
      if (result.success && result.data) {
        setStorageNotice(summariseCompaction(result.data));
      } else {
        setStorageNotice({ text: result.error ?? 'Compressing failed.', tone: 'warning' });
      }
    } catch (error) {
      setStorageNotice({ text: `Compressing failed: ${(error as Error).message}`, tone: 'warning' });
    } finally {
      setCompacting(null);
      // Re-read the sizes either way: on success to show the new figures, on
      // failure so the panel isn't left showing a number the user just acted on.
      await loadUsage();
    }
  };

  return (
    <div className="space-y-6">
      {confirmDialog}

      <UpdatesSection />

      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Storage
        </h3>
        <p className="text-sm text-muted-foreground mb-3">
          When you delete mail, the space it used is freed inside the database file but the file
          itself does not shrink — that space is held back for future mail instead of being returned
          to your disk. On a busy mailbox it can build up into gigabytes. Compressing rebuilds the
          file without the empty space, and hands it back to your disk.
        </p>
        {/* The single most important sentence in this section. "Compress" reads
            to most people as a lossy or archiving operation, and this is the
            place to say — before they click anything — that it is neither. */}
        <p className="text-sm text-muted-foreground mb-3">
          <span className="font-medium text-foreground">Your mail is not touched.</span> Nothing is
          deleted, shortened, archived or moved back to the server, and no attachment quality is
          reduced. Every message, flag and label stays exactly as it is — only the empty space goes.
          The rebuild is verified before it replaces the old file, and if it is interrupted the
          original is left intact.
        </p>
        <p className="text-sm text-muted-foreground mb-4">
          This can take several minutes on a large mailbox, and mail sync for that account pauses
          while it runs. Accounts only offer the button once there is enough wasted space for the
          rebuild to be worth its time.
        </p>

        {storageNotice && (
          <div
            className={`mb-4 rounded-md border px-3 py-2 text-sm ${NOTICE_STYLES[storageNotice.tone]}`}
          >
            {storageNotice.text}
          </div>
        )}

        {usage === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking database size…
          </div>
        ) : usage.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open account databases to compress.</p>
        ) : (
          <div className="space-y-3">
            {usage.map((account) => (
              <div
                key={account.accountId}
                className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {account.email}
                    {/* The same address can be configured on two servers, so the
                        host is the only thing telling these rows apart. */}
                    {account.host && (
                      <span className="ml-2 font-normal text-muted-foreground">{account.host}</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(account.fileBytes)} on disk
                    {account.freeBytes > 0 ? (
                      <> · {formatBytes(account.freeBytes)} reclaimable ({Math.round(account.freeRatio * 100)}%)</>
                    ) : (
                      <> · nothing to reclaim</>
                    )}
                  </div>
                  {/* Say WHY the button is dead. A greyed control with no reason
                      reads as broken, and the honest reason is reassuring: this
                      database is fine. */}
                  {!account.worthwhile && (
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      Nothing worth compressing yet — SQLite will reuse this space itself.
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleCompact(account)}
                  // Gated on `worthwhile`, not on "any free bytes": a rebuild is
                  // minutes of full-file rewrite under an exclusive lock, and
                  // spending that to reclaim 1% is a worse deal than leaving the
                  // pages for SQLite to reuse on the next writes.
                  disabled={compacting !== null || !account.worthwhile}
                  className="flex shrink-0 items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {compacting === account.accountId ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <HardDrive className="h-4 w-4" />
                  )}
                  {compacting === account.accountId ? 'Compressing…' : 'Compress'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Conversation Threading
        </h3>
        <p className="text-sm text-muted-foreground mb-4">
          New mail is grouped into conversations automatically. Run this once to also group your
          existing emails — messages that share the same subject and sender are combined into a
          single conversation thread.
        </p>

        {notice && (
          <div className="mb-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200">
            {notice}
          </div>
        )}

        <button
          onClick={handleRethread}
          disabled={busy}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <GitMerge className="h-4 w-4" />}
          Re-thread existing emails
        </button>
      </div>
    </div>
  );
}
