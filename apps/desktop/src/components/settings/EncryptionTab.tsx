import { KeyRound, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';

import type { PgpIpcResult } from '../../../electron/ipc/pgp-handlers';
import { useEmailStore } from '../../store/email-store';
import { useConfirm } from '../ConfirmDialog';

import {
  keyAddressChoices,
  keySourceLabel,
  keyWarnings,
  localDate,
  protectionText,
  shortFingerprint,
  type ContactKeySummary,
  type OwnKeySummary,
} from './encryption-view';
import type { AppSettings } from './types';

interface EncryptionTabProps {
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

type Notice = { text: string; tone: 'success' | 'error' };
type BridgeResult<T> = PgpIpcResult<T>;

/** Which passphrase form is open, for which key. One at a time. */
type KeyAction = { fingerprint: string; kind: 'unlock' | 'backup' } | null;

const SECTION_TITLE = 'text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider';
const INPUT = 'w-full px-3 py-2 text-sm rounded-md border border-border bg-background';
const BUTTON = 'px-3 py-1.5 text-sm rounded-md border border-border hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed';
const PRIMARY = 'px-3 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed';

const errorText = (error: unknown) => (error as Error)?.message ?? String(error);

export function EncryptionTab({ settings, updateSetting }: EncryptionTabProps) {
  const pgp = window.electronAPI.pgp;
  const accounts = useEmailStore((s) => s.accounts);
  const { confirm, confirmDialog } = useConfirm();
  const [keychain, setKeychain] = useState<boolean | null>(null);
  const [ownKeys, setOwnKeys] = useState<OwnKeySummary[] | null>(null);
  const [contactKeys, setContactKeys] = useState<ContactKeySummary[] | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyAction, setKeyAction] = useState<KeyAction>(null);

  const reload = useCallback(async () => {
    try {
      const [status, own, contacts] = await Promise.all([pgp.status(), pgp.listOwnKeys(), pgp.listContactKeys()]);
      setKeychain(status.success ? status.data.keychainAvailable : null);
      setOwnKeys(own.success ? own.data : []);
      setContactKeys(contacts.success ? contacts.data : []);
      const failed = [own, contacts].find((result) => !result.success);
      if (failed && !failed.success) setNotice({ text: failed.error, tone: 'error' });
    } catch (error) {
      setOwnKeys([]);
      setContactKeys([]);
      setNotice({ text: errorText(error), tone: 'error' });
    }
  }, [pgp]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Run one bridge call: busy while it runs, its error or success on the notice line, then refresh. */
  const run = async <T,>(task: () => Promise<BridgeResult<T>>, success: (data: T) => string | null): Promise<boolean> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await task();
      if (!result.success) {
        setNotice({ text: result.error, tone: 'error' });
        return false;
      }
      const text = success(result.data);
      if (text) setNotice({ text, tone: 'success' });
      await reload();
      return true;
    } catch (error) {
      setNotice({ text: errorText(error), tone: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const savedText = (what: string) => (data: { saved: boolean; filePath?: string }) =>
    data.saved ? `${what} saved to ${data.filePath}` : null;

  const deleteOwn = async (key: OwnKeySummary) => {
    const yes = await confirm({
      title: 'Delete this key?',
      message: `Mail encrypted to ${key.email} with this key can no longer be read here. Back it up first if you might need it.`,
      confirmLabel: 'Delete key',
    });
    if (yes) await run(() => pgp.deleteOwnKey(key.fingerprint), () => 'Key deleted');
  };

  const deleteContact = async (key: ContactKeySummary) => {
    const yes = await confirm({ title: 'Remove this key?', message: `You will no longer encrypt to ${key.email} with it.`, confirmLabel: 'Remove' });
    if (yes) await run(() => pgp.deleteContactKey(key.email, key.fingerprint), () => 'Key removed');
  };

  const submitKeyAction = async ({ fingerprint, kind }: NonNullable<KeyAction>, passphrase: string) => {
    const done =
      kind === 'unlock'
        ? await run(() => pgp.unlock(fingerprint, passphrase), () => 'Key unlocked until you quit')
        : await run(() => pgp.exportOwnKey(fingerprint, passphrase), savedText('Backup'));
    if (done) setKeyAction(null);
  };

  return (
    <div className="space-y-6">
      {confirmDialog}

      {notice && (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          className={`rounded-md border px-3 py-2 text-sm ${
            notice.tone === 'error'
              ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200'
              : 'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200'
          }`}
        >
          {notice.text}
        </div>
      )}

      {keychain === false && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          This system has no keychain to keep your keys in, so new keys are protected by their own passphrase. You will be
          asked for it once per session.
        </div>
      )}

      <Section title="Your keys">
        {ownKeys === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading keys" />
        ) : ownKeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            You have no OpenPGP key yet. Create one below, or import one you already use elsewhere.
          </p>
        ) : (
          <ul className="space-y-3">
            {ownKeys.map((key) => (
              <li key={key.fingerprint} data-own-key={key.fingerprint} className="rounded-md border border-border p-3 space-y-2">
                <KeyHeading email={key.email} fingerprint={key.fingerprint} warnings={keyWarnings(key)} />
                <div className="text-xs text-muted-foreground">
                  Created {localDate(key.createdAt)}
                  {key.expiresAt ? ` · expires ${localDate(key.expiresAt)}` : ''} · {protectionText(key.protection, keychain !== false)}
                </div>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={key.signByDefault}
                    disabled={busy}
                    onChange={(event) => void run(() => pgp.setSignByDefault(key.fingerprint, event.target.checked), () => null)}
                  />
                  Sign messages from {key.email} by default
                </label>
                <div className="flex flex-wrap gap-2">
                  {!key.unlocked && (
                    <button type="button" className={BUTTON} disabled={busy} onClick={() => setKeyAction({ fingerprint: key.fingerprint, kind: 'unlock' })}>
                      Unlock
                    </button>
                  )}
                  <button type="button" className={BUTTON} disabled={busy} onClick={() => void run(() => pgp.exportPublicKey(key.fingerprint), savedText('Public key'))}>
                    Export public key
                  </button>
                  <button type="button" className={BUTTON} disabled={busy} onClick={() => setKeyAction({ fingerprint: key.fingerprint, kind: 'backup' })}>
                    Back up secret key
                  </button>
                  <button type="button" className={`${BUTTON} text-destructive`} disabled={busy} onClick={() => void deleteOwn(key)}>
                    Delete
                  </button>
                </div>
                {keyAction?.fingerprint === key.fingerprint && (
                  <PassphraseForm
                    label={keyAction.kind === 'unlock' ? 'Passphrase of this key' : 'Passphrase for the backup file'}
                    hint={keyAction.kind === 'backup' ? 'The backup is protected by this passphrase. Keep it somewhere safe.' : undefined}
                    submitLabel={keyAction.kind === 'unlock' ? 'Unlock' : 'Save backup'}
                    busy={busy}
                    onSubmit={(passphrase) => submitKeyAction(keyAction, passphrase)}
                    onCancel={() => setKeyAction(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Create a key">
        <CreateKeyForm
          addresses={keyAddressChoices(accounts)}
          needsPassphrase={keychain === false}
          busy={busy}
          onCreate={(input) => run(() => pgp.generateKey(input), (key) => `Created a key for ${key.email}`)}
        />
      </Section>

      <Section title="Import your key">
        <ArmoredImportForm
          what="your private key"
          withPassphrase
          busy={busy}
          onImport={(armored, passphrase) =>
            run(() => pgp.importOwnKey(armored, passphrase), (keys) => `Imported ${keys.length === 1 ? 'your key' : `${keys.length} keys`}`)
          }
        />
      </Section>

      <Section title="Other people's keys">
        {contactKeys && contactKeys.length > 0 ? (
          <ul className="space-y-2 mb-4">
            {contactKeys.map((key) => (
              <li key={`${key.email}\u0000${key.fingerprint}`} data-contact-key={key.fingerprint} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                <div className="min-w-0 space-y-1">
                  <KeyHeading email={key.email} fingerprint={key.fingerprint} warnings={keyWarnings(key)} />
                  <div className="text-xs text-muted-foreground">
                    {keySourceLabel(key.source)} · last seen {localDate(key.lastSeen)}
                  </div>
                </div>
                <button type="button" className={`${BUTTON} text-destructive shrink-0`} disabled={busy} onClick={() => void deleteContact(key)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground mb-4">
            No keys yet. Keys arrive on their own from mail that carries them, or you can import one.
          </p>
        )}
        <ArmoredImportForm
          what="a public key"
          busy={busy}
          onImport={(armored) =>
            run(() => pgp.importContactKeys(armored), (keys) => `Imported ${keys.length === 1 ? `a key for ${keys[0]?.email}` : `${keys.length} keys`}`)
          }
        />
      </Section>

      <Section title="Finding keys" last>
        <div className="space-y-3">
          <SettingToggle
            checked={settings.pgpAutoEncrypt}
            onChange={(on) => updateSetting('pgpAutoEncrypt', on)}
            title="Encrypt automatically"
            detail="Turn encryption on by itself when every recipient has a key. You can still switch it off for one message."
          />
          <SettingToggle
            checked={settings.pgpWkdLookup}
            onChange={(on) => updateSetting('pgpWkdLookup', on)}
            title="Ask the recipient's mail domain for their key"
            detail="Web Key Directory. The domain already receives your mail, so it learns nothing new."
          />
          <SettingToggle
            checked={settings.pgpKeyserverLookup}
            onChange={(on) => updateSetting('pgpKeyserverLookup', on)}
            title="Search keys.openpgp.org"
            detail="A public key server run by a third party. It learns which addresses you look up — that is, who you write to."
          />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, last = false, children }: { title: string; last?: boolean; children: ReactNode }) {
  return (
    <div className={last ? 'pb-6' : 'border-b border-border pb-6'}>
      <h3 className={SECTION_TITLE}>{title}</h3>
      {children}
    </div>
  );
}

function KeyHeading({ email, fingerprint, warnings }: { email: string; fingerprint: string; warnings: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <KeyRound className="h-4 w-4 text-muted-foreground" aria-hidden />
      <span className="font-medium break-all">{email}</span>
      <code className="text-xs text-muted-foreground">{shortFingerprint(fingerprint)}</code>
      {warnings.map((warning) => (
        <span key={warning} className="rounded px-1.5 py-0.5 text-xs bg-amber-500/15 text-amber-700 dark:text-amber-300">
          {warning}
        </span>
      ))}
    </div>
  );
}

function SettingToggle({ checked, onChange, title, detail }: { checked: boolean; onChange: (on: boolean) => void; title: string; detail: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer py-2">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="w-4 h-4 mt-0.5" />
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-sm text-muted-foreground">{detail}</div>
      </div>
    </label>
  );
}

function PassphraseForm(props: {
  label: string;
  hint?: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (passphrase: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (passphrase) void props.onSubmit(passphrase);
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <input type="password" aria-label={props.label} placeholder={props.label} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className={INPUT} autoFocus />
      {props.hint && <p className="text-xs text-muted-foreground">{props.hint}</p>}
      <div className="flex gap-2">
        <button type="submit" className={PRIMARY} disabled={props.busy || !passphrase}>
          {props.submitLabel}
        </button>
        <button type="button" className={BUTTON} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CreateKeyForm(props: {
  addresses: string[];
  needsPassphrase: boolean;
  busy: boolean;
  onCreate: (input: { name: string; email: string; passphrase?: string }) => Promise<boolean>;
}) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const chosen = email || props.addresses[0] || '';
  const ready = !!chosen && (!props.needsPassphrase || !!passphrase);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    const created = await props.onCreate({ name, email: chosen, passphrase: props.needsPassphrase ? passphrase : undefined });
    if (created) setPassphrase('');
  };
  if (props.addresses.length === 0) {
    return <p className="text-sm text-muted-foreground">Add an account first — a key is made for one of your addresses.</p>;
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      <select aria-label="Address for the key" value={chosen} onChange={(event) => setEmail(event.target.value)} className={INPUT}>
        {props.addresses.map((address) => (
          <option key={address} value={address}>
            {address}
          </option>
        ))}
      </select>
      <input aria-label="Your name (optional)" placeholder="Your name (optional)" value={name} onChange={(event) => setName(event.target.value)} className={INPUT} />
      {props.needsPassphrase && (
        <input type="password" aria-label="Passphrase for the new key" placeholder="Passphrase for the new key" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className={INPUT} />
      )}
      <button type="submit" className={PRIMARY} disabled={props.busy || !ready}>
        {props.busy ? 'Working…' : 'Create key'}
      </button>
    </form>
  );
}

function ArmoredImportForm(props: {
  what: string;
  withPassphrase?: boolean;
  busy: boolean;
  onImport: (armored: string, passphrase?: string) => Promise<boolean>;
}) {
  const [armored, setArmored] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  const pickFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    try {
      setArmored(await file.text());
    } catch (error) {
      setFileError(errorText(error));
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!armored.trim()) return;
    const imported = await props.onImport(armored, props.withPassphrase && passphrase ? passphrase : undefined);
    if (imported) {
      setArmored('');
      setPassphrase('');
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3">
      <textarea
        aria-label={`Paste ${props.what}`}
        placeholder={`Paste ${props.what} (-----BEGIN PGP …)`}
        value={armored}
        onChange={(event) => setArmored(event.target.value)}
        rows={4}
        spellCheck={false}
        className={`${INPUT} font-mono text-xs`}
      />
      <input type="file" aria-label={`Choose a file with ${props.what}`} accept=".asc,.txt,.key,.pgp,.gpg" onChange={(event) => void pickFile(event.target.files?.[0])} className="text-sm" />
      {fileError && <p className="text-sm text-destructive">{fileError}</p>}
      {props.withPassphrase && (
        <input type="password" aria-label="Its passphrase, if it has one" placeholder="Its passphrase, if it has one" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className={INPUT} />
      )}
      <button type="submit" className={PRIMARY} disabled={props.busy || !armored.trim()}>
        Import
      </button>
    </form>
  );
}
