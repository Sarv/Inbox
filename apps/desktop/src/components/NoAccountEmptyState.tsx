import { Mail, Plus } from 'lucide-react';

/**
 * Shown in the mailbox area when there is no connected account (e.g. the user
 * removed their last one). Replaces the old blocking "Connect to IMAP" dialog:
 * it's non-blocking (the sidebar + Settings stay reachable) and offers the
 * 3-step add-account wizard directly.
 */
export function NoAccountEmptyState({ onAddAccount }: { onAddAccount: () => void }) {
  return (
    <div className="flex-1 flex items-center justify-center bg-background p-8">
      <div className="text-center max-w-sm">
        <Mail className="h-14 w-14 mx-auto mb-4 text-muted-foreground opacity-30" />
        <h2 className="text-lg font-semibold mb-1">No account connected</h2>
        <p className="text-sm text-muted-foreground mb-5">
          Add a mailbox to start reading and sending mail.
        </p>
        <button
          onClick={onAddAccount}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" /> Add account
        </button>
        <p className="text-xs text-muted-foreground mt-4">
          You can also manage accounts in Settings → Accounts.
        </p>
      </div>
    </div>
  );
}
