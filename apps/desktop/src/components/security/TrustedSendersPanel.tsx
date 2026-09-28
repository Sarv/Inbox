import { Info, Loader2, Trash2, UserCheck } from 'lucide-react';
import { useState } from 'react';

import { untrustSender, useTrustedSenders } from '../../utils/trusted-senders';
import { Tooltip } from '../Tooltip';

/**
 * The senders the user trusts, per account — added with "I trust this sender"
 * on a flagged message. Their mail is never filed as spam as long as it
 * authenticates; a message that fails authentication is judged like anyone's,
 * because that is what a forged copy of a trusted address looks like.
 * Removing one here, or reporting one of their messages as spam, withdraws it.
 */
export function TrustedSendersPanel() {
  const { senders } = useTrustedSenders();
  const [busy, setBusy] = useState<string | null>(null);

  const remove = async (address: string) => {
    setBusy(address);
    try { await untrustSender(address); } finally { setBusy(null); }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold flex items-center gap-2">
        <UserCheck className="h-4 w-4" /> Trusted senders
      </h3>
      <p className="text-xs text-muted-foreground">
        Mail from these addresses is never marked as spam, as long as it passes authentication (SPF, DKIM, DMARC). A
        message that fails it is still checked, since that is what a forged copy of a trusted address looks like.
      </p>
      {senders.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground flex items-center gap-2">
          <Info className="h-4 w-4" /> None yet. Use &ldquo;I trust this sender&rdquo; on a flagged message to add one.
        </div>
      ) : (
        <ul className="rounded-lg border border-border divide-y divide-border">
          {senders.map((s) => (
            <li key={s.email} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span className="truncate">{s.email}</span>
              <Tooltip content="Stop trusting this sender" delayMs={40}>
                <button
                  onClick={() => void remove(s.email)}
                  disabled={busy !== null}
                  aria-label={`Stop trusting ${s.email}`}
                  className="rounded-md p-1 text-muted-foreground hover:text-destructive hover:bg-muted/60 disabled:opacity-50"
                >
                  {busy === s.email ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
