import { Download, Loader2, Lock, LockKeyhole, RotateCw, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { qualifiesForSafeAutoLoad } from '../../store/helpers';
import { formatSize } from '../attachment-viewer/AttachmentViewer';
import { SandboxedEmailBody } from '../SandboxedEmailBody';
import { Tooltip } from '../Tooltip';

import {
  pgpBadge,
  pgpFailureView,
  unlockLockedKeys,
  type PgpBadge,
  type PgpViewResult,
} from './pgp-view-model';

export interface PgpMessageViewProps {
  email: {
    id: string;
    accountId?: string;
    pgpStatus?: 'encrypted' | 'signed' | null;
    fromAddress?: string;
    tags?: string | null;
  };
  /** The stored body — what an unencrypted (or only signed) message shows. */
  children: ReactNode;
}

type OpenState = { phase: 'opening' } | { phase: 'done'; view: PgpViewResult };

const BADGE_STYLE: Record<PgpBadge['tone'], string> = {
  good: 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300',
  neutral: 'border-border bg-muted text-muted-foreground',
  bad: 'border-red-500/40 bg-red-500/[0.08] text-red-700 dark:text-red-300',
};
const BADGE_ICON = { good: ShieldCheck, neutral: ShieldQuestion, bad: ShieldAlert } as const;

function PgpBadgeChip({ badge, encrypted }: { badge: PgpBadge; encrypted: boolean }) {
  const Icon = encrypted && badge.tone === 'good' ? Lock : BADGE_ICON[badge.tone];
  return (
    <Tooltip content={badge.detail} delayMs={40} maxWidth={320}>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${BADGE_STYLE[badge.tone]}`}
        aria-label={badge.detail}
        data-pgp-badge={badge.tone}
      >
        <Icon className="h-3.5 w-3.5" />
        {badge.label}
      </span>
    </Tooltip>
  );
}

function UnlockForm({ onUnlocked }: { onUnlocked: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      const unlocked = await unlockLockedKeys(window.electronAPI.pgp, passphrase);
      if (unlocked > 0) {
        setPassphrase('');
        onUnlocked();
      } else {
        setError('That passphrase did not unlock any of your keys.');
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-center gap-2">
      <input
        type="password"
        autoFocus
        value={passphrase}
        onChange={(event) => setPassphrase(event.target.value)}
        placeholder="Key passphrase"
        aria-label="Key passphrase"
        className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm"
      />
      <button
        type="submit"
        disabled={!passphrase || busy}
        className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
      {error && <p className="w-full text-xs text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}

/**
 * The reader for OpenPGP mail. An encrypted message's stored body is only a
 * placeholder, so this opens it from the message source (in the main process)
 * and shows the plaintext for as long as the card is on screen — it is never
 * written anywhere. A signed message shows its stored body with a badge.
 */
export function PgpMessageView({ email, children }: PgpMessageViewProps) {
  const status = email.pgpStatus ?? null;
  const [state, setState] = useState<OpenState>({ phase: 'opening' });
  const [attempt, setAttempt] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!status) return undefined;
    let current = true;
    setState({ phase: 'opening' });
    window.electronAPI.pgp
      .open(email.id, email.accountId)
      .then((view) => current && setState({ phase: 'done', view }))
      .catch((error: Error) => current && setState({ phase: 'done', view: { ok: false, code: 'unavailable', error: error.message } }));
    return () => {
      current = false;
    };
  }, [email.id, email.accountId, status, attempt]);

  if (!status) return <>{children}</>;

  const view = state.phase === 'done' ? state.view : null;
  const badge = view?.ok ? pgpBadge(view.wasEncrypted, view.signature) : null;
  const badgeRow = badge && (
    <div className="mb-3 flex">
      <PgpBadgeChip badge={badge} encrypted={view?.ok === true && view.wasEncrypted} />
    </div>
  );

  if (status === 'signed' || (view?.ok && !view.wasEncrypted)) {
    return (
      <>
        {badgeRow}
        {children}
      </>
    );
  }

  if (!view) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground" role="status">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        Decrypting…
      </div>
    );
  }

  if (!view.ok) {
    const failure = pgpFailureView(view.code, view.error);
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/[0.07] p-4 dark:bg-amber-400/[0.10]" role="alert">
        <div className="flex items-start gap-3">
          <LockKeyhole className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">{failure.title}</div>
            <p className="mt-1 text-xs text-muted-foreground break-words">{failure.detail}</p>
            {failure.canUnlock && <UnlockForm onUnlocked={() => setAttempt((n) => n + 1)} />}
            {failure.canRetry && (
              <button
                onClick={() => setAttempt((n) => n + 1)}
                className="mt-2 inline-flex items-center gap-1 rounded px-3 py-1 text-sm text-primary hover:bg-primary/10"
              >
                <RotateCw className="h-3.5 w-3.5" />
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const save = async (index: number) => {
    setSaveError(null);
    const result = await window.electronAPI.pgp.saveAttachment(email.id, email.accountId, index);
    if (!result.success) setSaveError(result.error);
  };

  return (
    <>
      {badgeRow}
      <div className="max-w-none">
        {view.contentType === 'html' ? (
          <SandboxedEmailBody html={view.body} safeAutoLoad={qualifiesForSafeAutoLoad(email.tags)} senderAddress={email.fromAddress} />
        ) : (
          <div className="whitespace-pre-wrap font-sans leading-relaxed text-foreground">{view.body}</div>
        )}
      </div>
      {view.attachments.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
          {view.attachments.map((attachment) => (
            <Tooltip key={attachment.index} content={`Save ${attachment.name}`} delayMs={40}>
              <button
                onClick={() => void save(attachment.index)}
                aria-label={`Save ${attachment.name}`}
                className="inline-flex max-w-xs items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent"
              >
                <Download className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{attachment.name}</span>
                <span className="flex-shrink-0 text-xs text-muted-foreground">{formatSize(attachment.size)}</span>
              </button>
            </Tooltip>
          ))}
        </div>
      )}
      {saveError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{saveError}</p>}
    </>
  );
}
