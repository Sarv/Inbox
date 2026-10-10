import { parseSpamReasons, spamVerdict } from '@sarv-in/mailguard/verdict';
import { describeImageAllowEntry, type ImageAllowEntry } from '@sarvinbox/core/image-allowlist';
import { ShieldCheck, Shield, ShieldQuestion, ShieldAlert, ShieldX, Trash2, Link2, AtSign, Globe, Plus, Info, Loader2, BadgeCheck, RefreshCw, Ban, Check } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { useSecureStorageProtected } from '../../hooks/useSecureStorageProtected';
import { useEmailStore } from '../../store/email-store';
import { accountDisplayLabel } from '../../store/helpers';
import { LEVEL_COPY, type SecurityLevel } from '../../utils/email-security';
import {
  forgetImagesAllowed,
  rememberImagesAllowed,
  remoteImageModeFor,
  remoteImageSourcesOf,
  saveRemoteImageMode,
  useRemoteImageMode,
  type RemoteImageSources,
} from '../../utils/remote-images';
import { removeLinkRule, useLinkRules, type LinkRule } from '../../utils/security-rules';
import { reloadTrustedSenders } from '../../utils/trusted-senders';
import { useConfirm } from '../ConfirmDialog';
import { BlockedSendersPanel } from '../settings/BlockedSendersPanel';
import { Tooltip } from '../Tooltip';

import { BlocklistsTab } from './BlocklistsTab';
import { TrustedSendersPanel } from './TrustedSendersPanel';

type SecurityTab = 'overview' | 'links' | 'senders' | 'images' | 'identity' | 'blocklists' | 'spam';

const tabs: { id: SecurityTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'links', label: 'Trusted & blocked links' },
  { id: 'senders', label: 'Blocked senders' },
  { id: 'images', label: 'Remote images' },
  { id: 'identity', label: 'Sender identity' },
  { id: 'blocklists', label: 'Blocklists' },
  { id: 'spam', label: 'Spam' },
];

const LEVEL_ICON: Record<SecurityLevel, typeof Shield> = {
  verified: ShieldCheck, authenticated: Shield, unverified: ShieldQuestion, caution: ShieldAlert, danger: ShieldX,
};
const LEVEL_TONE: Record<SecurityLevel, string> = {
  verified: 'text-green-600 dark:text-green-400',
  authenticated: 'text-blue-600 dark:text-blue-400',
  unverified: 'text-muted-foreground',
  caution: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
};
const LEVEL_ORDER: SecurityLevel[] = ['verified', 'authenticated', 'unverified', 'caution', 'danger'];

/**
 * Security — one place for everything that decides whether a message is
 * trusted, and every allowance the user has granted. The shield beside each
 * sender is the per-message view; this is the whole picture.
 */
export function Security({ initialTab }: { initialTab?: SecurityTab } = {}) {
  const [activeTab, setActiveTab] = useState<SecurityTab>(initialTab ?? 'overview');

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Security</h1>
        </div>
      </div>

      <div className="px-6 border-b border-border">
        <nav className="flex gap-1 -mb-px overflow-x-auto" aria-label="Security sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === 'overview' && <OverviewTab />}
        {activeTab === 'links' && <LinksTab />}
        {activeTab === 'senders' && (
          <div className="p-6"><BlockedSendersPanel /></div>
        )}
        {activeTab === 'images' && <ImagesTab />}
        {activeTab === 'identity' && <IdentityTab />}
        {activeTab === 'blocklists' && <BlocklistsTab />}
        {activeTab === 'spam' && <SpamTab />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Overview */

const MAIL_CACHE_TITLE = 'Encrypted mail cache';

/** The mail cache card where no keyring protects its key (Linux `basic_text`): still encrypted, but the key is readable. */
const MAIL_CACHE_UNPROTECTED_DETAIL =
  'The local mailbox database is encrypted, but this system has no keyring, so the key to it is only obfuscated: anyone who '
  + 'copies your profile can read your stored mail. Install and unlock a keyring (e.g. gnome-keyring or KWallet), then restart Sarv Inbox.';

const PROTECTIONS: Array<{ title: string; detail: string }> = [
  { title: 'Isolated message rendering', detail: 'Every email body renders inside a sandboxed frame. Scripts, stylesheets, fonts and imports are stripped before it loads.' },
  { title: 'Links open in your browser', detail: 'Clicking a link never navigates inside the app — it hands the address to your system browser with referrer and opener stripped.' },
  { title: 'Sender authentication', detail: 'SPF, DKIM and DMARC verdicts are read from the receiving server’s Authentication-Results header and shown on the shield beside each sender.' },
  { title: 'Impersonation checks', detail: 'A display name that names one domain while the message came from another, and links whose text says one domain while pointing to another, are flagged.' },
  { title: 'Brand verification (BIMI)', detail: 'A sender domain’s published logo is shown only on mail that passed DMARC, and the blue verified tick only when its Verified Mark Certificate chains to a pinned Mark Verifying Authority for that exact logo and domain. Details per domain under Sender identity.' },
  { title: 'Sender reputation', detail: 'As a message arrives, its sending server’s address and its sender domains are checked against spam blocklists — through this computer’s DNS, or Sarv’s reputation service with your own sign-in — and a listing adds to the spam score before the message is filed. The domains a message links to can be checked too, and how recently its domains were registered. All of it under Security → Blocklists.' },
  { title: 'Spam filter', detail: 'Every arriving message is scored from its headers before the AI sees it — failed authentication, a spoofed sender name, a forged reply, missing or mis-dated headers, bulk mail with no unsubscribe, your mail server’s own spam verdict, and senders you have reported. A message over the line is filed as spam with its reasons shown on the shield.' },
  { title: MAIL_CACHE_TITLE, detail: 'The local mailbox database is encrypted at rest; the key lives in the operating system keychain.' },
  { title: 'Verified TLS to your mail server', detail: 'Certificates are verified and TLS 1.2 is the floor, unless you explicitly allow a self-signed server per account.' },
];

function HeaderBackfillStatus() {
  const [state, setState] = useState<{ remaining: number; done: number; running: boolean; drained: boolean } | null>(null);
  useEffect(() => {
    const api = window.electronAPI.security;
    api.getHeaderBackfillState?.().then((r) => { if (r?.success && r.data) setState(r.data); }).catch(() => { /* best-effort */ });
    const off = api.onHeaderBackfillProgress?.((s) => setState(s));
    return () => { off?.(); };
  }, []);
  if (!state) return null;
  const total = state.remaining + state.done;
  if (state.drained && state.done === 0) return null; // nothing ever needed doing
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex items-center gap-3 text-sm">
      {state.drained
        ? <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0" />
        : <Loader2 className="h-4 w-4 animate-spin text-primary flex-shrink-0" />}
      <div className="min-w-0 flex-1">
        {state.drained ? (
          <span>Older mail checked — {state.done.toLocaleString()} message{state.done === 1 ? '' : 's'} given an authentication verdict and a spam score.</span>
        ) : (
          <span>
            Checking older mail: <b>{state.done.toLocaleString()}</b> of {total.toLocaleString()} done,
            {' '}{state.remaining.toLocaleString()} to go. Messages show <i>Unverified</i> and <i>Not scored</i> until their turn.
          </span>
        )}
      </div>
      {!state.drained && !state.running && (
        <button
          onClick={() => { void window.electronAPI.security.kickHeaderBackfill?.(); }}
          className="shrink-0 px-2.5 py-1 rounded-md border border-border text-xs hover:bg-muted/60 transition-colors"
        >
          Run now
        </button>
      )}
    </div>
  );
}

/** Who a provider name is, as a reader should see it. */
const PROVIDER_LABEL: Record<string, string> = {
  'local-dnsbl': 'this computer’s DNS',
  sarv: 'the Sarv reputation service',
};

/**
 * Where the spam filter's reputation checks stand: who the blocklists are
 * asked through as mail arrives, what the background pass (link domains,
 * registration dates) has judged and still has waiting, and anything a
 * provider said it could not answer — a Spamhaus refusal through a public
 * resolver, no Sarv sign-in.
 */
function ReputationStatus() {
  const [state, setState] = useState<{
    pending: number; judged: number; filed: number; linkPending?: number; linkJudged?: number;
    blocklists?: string | null; linkProvider?: string | null; domainAge?: boolean; ageChecked?: number;
    notes: string[]; running: boolean; lastRun: number | null;
  } | null>(null);
  useEffect(() => {
    const api = window.electronAPI.spam;
    api?.getReputationState?.().then((r) => { if (r?.success && r.data) setState(r.data); }).catch(() => { /* best-effort */ });
    const off = api?.onReputationProgress?.((s) => setState(s));
    return () => { off?.(); };
  }, []);
  if (!state) return null;
  const who = state.blocklists ? PROVIDER_LABEL[state.blocklists] ?? state.blocklists : null;
  const background = !!state.domainAge || !!state.linkProvider;
  const judged = state.judged + (state.linkJudged ?? 0);
  const waiting = state.pending + (state.linkPending ?? 0);
  const ageLine = (state.ageChecked ?? 0) > 0 ? ` ${(state.ageChecked ?? 0).toLocaleString()} domain registration date${state.ageChecked === 1 ? '' : 's'} looked up.` : '';
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex items-start gap-3 text-sm">
      {state.running ? <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-primary flex-shrink-0" /> : <ShieldCheck className="h-4 w-4 mt-0.5 text-green-600 dark:text-green-400 flex-shrink-0" />}
      <div className="min-w-0 flex-1 space-y-1">
        {who ? (
          <p>
            Blocklists are asked about every arriving sender through <b>{who}</b>
            {state.linkProvider ? ', and about the domains a message links to once its body is downloaded' : ''}.
          </p>
        ) : (
          <p>Blocklists are off, or the Sarv service address is not set — senders are judged from their headers alone. Change this under Security → Blocklists.</p>
        )}
        {background && (
          <p className="text-muted-foreground">
            Background checks: {judged.toLocaleString()} message{judged === 1 ? '' : 's'} judged this session,
            {' '}{state.filed.toLocaleString()} filed as spam by them, {waiting.toLocaleString()} waiting.{ageLine}
          </p>
        )}
        {state.notes.length > 0 && (
          <ul className="text-xs text-muted-foreground list-disc pl-4">
            {state.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      </div>
      {background && (
        <button
          onClick={() => { void window.electronAPI.spam?.kickReputation?.(); }}
          className="shrink-0 px-2.5 py-1 rounded-md border border-border text-xs hover:bg-muted/60 transition-colors"
        >
          Run now
        </button>
      )}
    </div>
  );
}

function OverviewTab() {
  const secretsProtected = useSecureStorageProtected();
  return (
    <div className="p-6 max-w-4xl space-y-8">
      <HeaderBackfillStatus />
      <ReputationStatus />
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Security levels</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Every message gets a level, shown as the shield beside the sender. Hover it to see each check.
        </p>
        <div className="space-y-2">
          {LEVEL_ORDER.map((level) => {
            const Icon = LEVEL_ICON[level];
            return (
              <div key={level} className="flex items-start gap-3 rounded-lg border border-border bg-card p-3">
                <Icon className={`h-5 w-5 mt-0.5 flex-shrink-0 ${LEVEL_TONE[level]}`} />
                <div className="min-w-0">
                  <div className={`font-medium ${LEVEL_TONE[level]}`}>{LEVEL_COPY[level].title}</div>
                  <div className="text-sm text-muted-foreground">{LEVEL_COPY[level].summary}</div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">What is always on</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {PROTECTIONS.map((p) => {
            const exposed = p.title === MAIL_CACHE_TITLE && secretsProtected === false;
            return (
              <div key={p.title} data-protection={p.title} className="rounded-lg border border-border bg-card p-3">
                <div className="flex items-center gap-2 font-medium">
                  {exposed
                    ? <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    : <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />}
                  {p.title}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">{exposed ? MAIL_CACHE_UNPROTECTED_DETAIL : p.detail}</div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------- Links */

function LinksTab() {
  const { rules } = useLinkRules();
  const { confirm, confirmDialog } = useConfirm();
  const trusted = rules.filter((r) => r.verdict === 'trust');
  const blocked = rules.filter((r) => r.verdict === 'block');

  const revoke = async (rule: LinkRule) => {
    const ok = await confirm({
      title: rule.verdict === 'trust' ? 'Stop trusting this link?' : 'Unblock this link?',
      message: `${rule.shownDomain} → ${rule.actualDomain}\nfrom ${rule.senderDomain || 'any sender'}\n\n`
        + (rule.verdict === 'trust'
          ? 'Messages with this link will be flagged again.'
          : 'Messages with this link will no longer be marked dangerous.'),
      confirmLabel: rule.verdict === 'trust' ? 'Stop trusting' : 'Unblock',
      destructive: rule.verdict === 'trust',
    });
    if (ok) await removeLinkRule(rule.id);
  };

  return (
    <div className="p-6 max-w-4xl space-y-8">
      {confirmDialog}
      <p className="text-sm text-muted-foreground flex items-start gap-2">
        <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <span>
          A rule applies to one <b>sender domain</b> and one <b>text → destination</b> pair. Trusting a pair for one
          sender does not trust it for anyone else — a compromised familiar account is the usual way phishing arrives
          from a known name. Add rules from the warning banner on a message.
        </span>
      </p>

      <RuleList
        title="Trusted links"
        empty="No trusted links yet. When a message shows a link warning you recognise as legitimate, choose “I trust this link”."
        rules={trusted}
        tone="text-green-600 dark:text-green-400"
        onRevoke={revoke}
        revokeLabel="Stop trusting"
      />
      <RuleList
        title="Blocked links"
        empty="No blocked links. From a link warning, choose “Block this link” to mark any message carrying it as dangerous."
        rules={blocked}
        tone="text-red-600 dark:text-red-400"
        onRevoke={revoke}
        revokeLabel="Unblock"
      />
    </div>
  );
}

function RuleList({ title, empty, rules, tone, onRevoke, revokeLabel }: {
  title: string; empty: string; rules: LinkRule[]; tone: string;
  onRevoke: (r: LinkRule) => void; revokeLabel: string;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        {title} <span className="text-muted-foreground/70 font-normal">({rules.length})</span>
      </h2>
      {rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">{empty}</div>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border">
          {rules.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Link2 className={`h-4 w-4 flex-shrink-0 ${tone}`} />
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  <span className="font-medium">{r.shownDomain}</span>
                  <span className="text-muted-foreground"> → </span>
                  <span className="font-medium">{r.actualDomain}</span>
                </div>
                <div className="text-xs text-muted-foreground truncate">from {r.senderDomain || 'any sender'}</div>
              </div>
              <Tooltip content={revokeLabel} delayMs={40}>
                <button
                  onClick={() => onRevoke(r)}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  aria-label={`${revokeLabel}: ${r.shownDomain} to ${r.actualDomain}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Images */

type ImageSourceKey = keyof RemoteImageSources;

/**
 * What each switch loads — worded to match what `shouldAutoLoadRemoteImages`
 * (utils/remote-images.ts) actually does. The two sources are independent:
 * either, both or neither. The allowed list below loads whatever is on and is
 * checked first, so it is not held back by Spam or a failed sender check; the
 * category source trusts the AI's filing and does not look at the sender.
 */
const SOURCE_COPY: Record<ImageSourceKey, { title: string; detail: string }> = {
  trusted: {
    title: 'From trusted senders',
    detail: 'Senders you marked “I trust this sender”, people you’ve emailed from the account the message arrived in, and verified brands (blue tick) — unless the message is in Spam or failed its sender check. Your allowed list below is separate.',
  },
  categorized: {
    title: 'From categorized mail',
    detail: 'Mail the AI filed into one of your categories, except Social, Promotional and Spam. This goes by the category, not the sender.',
  },
  always: {
    title: 'Always load all remote images',
    detail: 'Every remote image loads when you open a message, whoever sent it. Senders with tracking pixels learn when and where you read.',
  },
};

/** One checkbox row: named by its title, described by its detail (and, when
 *  "Always" covers it, by a note saying so). The whole row is the label. */
function ImageSourceOption({ source, checked, disabled = false, coveredNoteId, onChange }: {
  source: ImageSourceKey;
  checked: boolean;
  disabled?: boolean;
  /** Set while "Always" is on and covers this source: the id of the note saying so. */
  coveredNoteId?: string;
  onChange: (checked: boolean) => void;
}) {
  const baseId = useId();
  const copy = SOURCE_COPY[source];
  const inputId = `${baseId}-input`;
  const titleId = `${baseId}-title`;
  const detailId = `${baseId}-detail`;
  return (
    <label
      htmlFor={inputId}
      className={`flex items-start gap-3 px-3 py-3 text-sm transition-colors ${disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-accent/40'}`}
    >
      <input
        id={inputId}
        type="checkbox"
        value={source}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-labelledby={titleId}
        aria-describedby={coveredNoteId ? `${detailId} ${coveredNoteId}` : detailId}
        className="h-4 w-4 mt-0.5 flex-shrink-0 accent-primary disabled:opacity-60"
      />
      <span className={`flex-1 min-w-0 ${disabled ? 'opacity-70' : ''}`}>
        <span id={titleId} className="font-medium">{copy.title}</span>
        <span id={detailId} className="block text-xs text-muted-foreground">{copy.detail}</span>
      </span>
    </label>
  );
}

/**
 * When remote images load on their own, chosen here and nowhere else: trusted
 * senders and categorized mail, each on or off independently, or everything.
 * A change is saved the moment it is made, into the same settings the whole
 * app reads (`saveRemoteImageMode`, one stored value — see
 * `remoteImageModeFor`), and every open message re-decides at once — no Save
 * button, no reload. The Settings screen's own Save never writes its (possibly
 * stale) copy of it back.
 *
 * "Always" includes both sources, so while it is on they show ticked and
 * cannot be changed. Turning it off gives back the two choices the reader had
 * before turning it on, as long as this page has stayed open; otherwise (the
 * page opened with "Always" already on, or was left since) both come back on —
 * what the ticked boxes showed, and the default.
 */
function RemoteImageSwitches() {
  const sources = remoteImageSourcesOf(useRemoteImageMode());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [beforeAlways, setBeforeAlways] = useState<Pick<RemoteImageSources, 'trusted' | 'categorized'> | null>(null);
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const introId = `${baseId}-intro`;
  const coveredId = `${baseId}-covered`;

  const save = (next: RemoteImageSources): boolean => {
    const saved = saveRemoteImageMode(remoteImageModeFor(next));
    setSaveError(saved ? null : 'Your choice was not saved: the app could not read or write your settings. Nothing was changed.');
    return saved;
  };

  const setSource = (source: 'trusted' | 'categorized', on: boolean) => {
    save({ ...sources, [source]: on });
  };

  const setAlways = (on: boolean) => {
    if (on) {
      const { trusted, categorized } = sources;
      if (save({ trusted: true, categorized: true, always: true })) setBeforeAlways({ trusted, categorized });
      return;
    }
    if (save({ ...(beforeAlways ?? { trusted: true, categorized: true }), always: false })) setBeforeAlways(null);
  };

  const nothingOn = !sources.always && !sources.trusted && !sources.categorized;

  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        When to load remote images
      </h2>
      <p id={introId} className="text-sm text-muted-foreground mb-4">
        A remote image tells its sender when you opened the message, and from where. Choose which mail loads them on
        its own — trusted senders, categorized mail, both (the default) or neither. The choice applies to every
        account; the trusted senders, the people you’ve emailed and the allowed list are each account’s own.
      </p>
      <fieldset aria-describedby={introId}>
        <legend className="text-sm font-medium mb-2">Load images automatically</legend>
        <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
          {(['trusted', 'categorized'] as const).map((source) => (
            <ImageSourceOption
              key={source}
              source={source}
              checked={sources[source]}
              disabled={sources.always}
              coveredNoteId={sources.always ? coveredId : undefined}
              onChange={(on) => setSource(source, on)}
            />
          ))}
        </div>
        {sources.always && (
          <p id={coveredId} className="mt-2 text-xs text-muted-foreground">
            Both are included while “Always load all remote images” is on.
          </p>
        )}
      </fieldset>
      <div className="mt-4 rounded-lg border border-border overflow-hidden">
        <ImageSourceOption source="always" checked={sources.always} onChange={setAlways} />
      </div>
      <div aria-live="polite">
        {nothingOn && (
          <p className="mt-2 text-xs text-muted-foreground">
            Images load only after you choose “Load images” on a message, except from senders on your allowed list below.
          </p>
        )}
      </div>
      {saveError && <p role="alert" className="mt-2 text-xs text-destructive">{saveError}</p>}
    </section>
  );
}

/**
 * Remote images: when they load on their own (the switches, above), and every
 * standing allowance, which the reader can add by hand as well as by clicking
 * "Load images" on a message. An allowance is one sender (`boss@x.com`) or a
 * whole domain (`@x.com`, which also covers `news.x.com`), because a
 * newsletter's actual envelope sender is usually some per-campaign address
 * nobody would think to type.
 */
function ImagesTab() {
  const [allowed, setAllowed] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { confirm, confirmDialog } = useConfirm();
  // The allowed list is per account: this section shows, adds to and revokes
  // from the ACTIVE account's, named explicitly in every call (and in the
  // heading) — a "Load images" click on another account's mail in All Inboxes
  // is saved to that account and appears under it.
  const accountId = useEmailStore((s) => s.activeAccountId) ?? undefined;
  const accountLabel = useEmailStore((s) => accountDisplayLabel(s.accounts, s.activeAccountId ?? undefined));

  const load = async () => {
    try {
      const res = await window.electronAPI.emails.getImageAllowedSenders(accountId);
      // Unsorted on purpose — `entries` below is the one place that orders this
      // list, and sorting the raw keys first would only hide what it does.
      if (res?.success && Array.isArray(res.data)) setAllowed([...res.data]);
    } catch { /* best-effort */ }
  };
  useEffect(() => { void load(); }, [accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Domains first, then senders — the broad rules are the ones worth reviewing.
  const entries: ImageAllowEntry[] = useMemo(
    () => allowed
      .map(describeImageAllowEntry)
      .sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === 'domain' ? -1 : 1)),
    [allowed],
  );

  const add = async () => {
    const entry = rememberImagesAllowed(draft, accountId);
    if (!entry) {
      setError('Enter a sender address (boss@example.com) or a domain (example.com).');
      return;
    }
    setDraft('');
    setError(null);
    await load();
  };

  const revoke = async (entry: ImageAllowEntry) => {
    const ok = await confirm({
      title: entry.kind === 'domain' ? 'Stop auto-loading for this domain?' : 'Stop auto-loading images?',
      message: `${entry.label}\n\n`
        + (entry.kind === 'domain'
          ? 'Images from this domain will be blocked again unless a sender on it is allowed on its own.'
          : 'Images from this sender will be blocked again until you choose “Load images” on a message.'),
      confirmLabel: 'Stop auto-loading',
    });
    if (!ok) return;
    forgetImagesAllowed(entry.key, accountId);
    await load();
  };

  return (
    <div className="p-6 max-w-4xl space-y-8">
      {confirmDialog}
      <RemoteImageSwitches />

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Allowed to load images <span className="text-muted-foreground/70 font-normal">({entries.length})</span>
          {accountLabel && (
            <span className="ml-2 normal-case tracking-normal font-normal text-muted-foreground/70">— {accountLabel}</span>
          )}
        </h2>

        <div className="bg-muted/30 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-medium mb-1">Always load images from…</h3>
          <p className="text-xs text-muted-foreground mb-3">
            A sender address (<code>boss@example.com</code>) or a whole domain (<code>example.com</code>, which also
            covers <code>news.example.com</code>). An allowance here overrides the policy above.
          </p>
          <div className="flex gap-3">
            <input
              type="text"
              placeholder="boss@example.com or example.com"
              value={draft}
              aria-label="Sender address or domain to always load images from"
              aria-invalid={error ? true : undefined}
              onChange={(e) => { setDraft(e.target.value); if (error) setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
              className="flex-1 px-3 py-2 border border-border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <button
              onClick={() => void add()}
              disabled={!draft.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            >
              <Plus className="h-4 w-4" />
              Allow
            </button>
          </div>
          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        </div>

        {entries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No allowances yet. Add one above, or click “Load images” on a message to add its sender.
          </div>
        ) : (
          <div className="rounded-lg border border-border divide-y divide-border">
            {entries.map((entry) => (
              <div key={entry.key} className="flex items-center gap-3 px-3 py-2 text-sm">
                {entry.kind === 'domain'
                  ? <Globe className="h-4 w-4 flex-shrink-0 text-primary" />
                  : <AtSign className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
                <span className="flex-1 truncate">{entry.label}</span>
                <span className="text-xs text-muted-foreground flex-shrink-0">
                  {entry.kind === 'domain' ? 'Whole domain' : 'Sender'}
                </span>
                <Tooltip content="Stop auto-loading" delayMs={40}>
                  <button
                    onClick={() => revoke(entry)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    aria-label={`Stop auto-loading images from ${entry.label}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- Identity */

interface IdentityRow {
  domain: string;
  bimiStatus: 'verified' | 'logo' | 'declined' | 'none' | 'invalid' | 'error' | null;
  bimiLogo: string | null;
  bimiOrganization: string | null;
  bimiIssuer: string | null;
  bimiExpires: number | null;
  bimiDetail: string | null;
  /**
   * Which zone's BIMI record answered. Not always `domain`: the lookup falls
   * back to the organisational domain, so a reader who goes to check their own
   * DNS has to be told which one to look in.
   */
  bimiRecordDomain: string | null;
  dmarcPolicy: string | null;
  bimiCheckedAt: number | null;
  favicon: string | null;
  faviconStatus: 'found' | 'none' | 'error' | null;
  faviconDetail: string | null;
  faviconCheckedAt: number | null;
  updatedAt: number;
}

const BIMI_PILL: Record<NonNullable<IdentityRow['bimiStatus']>, { label: string; tone: string }> = {
  verified: { label: 'Verified mark', tone: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
  logo: { label: 'Logo, no certificate', tone: 'bg-green-500/15 text-green-700 dark:text-green-300' },
  declined: { label: 'Declined', tone: 'bg-muted text-muted-foreground' },
  none: { label: 'No BIMI', tone: 'bg-muted text-muted-foreground' },
  invalid: { label: 'Unusable', tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  error: { label: 'Lookup failed', tone: 'bg-red-500/15 text-red-700 dark:text-red-300' },
};

const when = (sec: number | null) => (sec ? new Date(sec * 1000).toLocaleString() : 'never');

/**
 * The BIMI answer in full, as term/value pairs for the info tooltip.
 *
 * This lives behind an icon rather than in the cell because the reason a
 * domain's standing is what it is ("BIMI requires an enforcing DMARC policy;
 * the domain's is p=none") is a SENTENCE, and a sentence in an auto-laid-out
 * table takes every pixel the other columns needed — which is how the domain
 * itself came to be rendered a few characters at a time.
 */
const bimiFacts = (row: IdentityRow): [term: string, value: string][] => {
  const certificate = row.bimiOrganization
    ? [
        row.bimiOrganization,
        row.bimiIssuer ? `issued by ${row.bimiIssuer}` : null,
        row.bimiExpires ? `expires ${new Date(row.bimiExpires * 1000).toLocaleDateString()}` : null,
      ].filter(Boolean).join(' — ')
    : 'None';
  return [
    // The From domain and the domain whose record answered are not always the
    // same — BIMI falls back to the organisational domain — and a reader
    // checking their own DNS needs to know which zone to look in.
    ['Record', row.bimiRecordDomain ?? 'None published'],
    ['Logo', row.bimiLogo ? 'Published' : 'None'],
    ['Certificate', certificate],
    ['DMARC', row.dmarcPolicy ? `p=${row.dmarcPolicy}` : 'Not published'],
    ['Checked', when(row.bimiCheckedAt)],
  ];
};

/** The tooltip body behind the (i) in the Brand column. */
function BimiRecordCard({ row, label }: { row: IdentityRow; label: string }) {
  return (
    <div className="text-left">
      <div className="font-semibold">{label}</div>
      {row.bimiDetail && <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{row.bimiDetail}</div>}
      <dl className="mt-2 space-y-1 text-[11px] leading-snug">
        {bimiFacts(row).map(([term, value]) => (
          <div key={term} className="flex gap-2">
            <dt className="w-[4.5rem] shrink-0 text-muted-foreground">{term}</dt>
            <dd className="flex-1 break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * Every domain whose identity has been looked up: the logo or favicon the
 * avatar draws from, the BIMI standing with its reason, and the certificate's
 * organisation and issuer. "Refresh" re-runs the lookup now; "Forget" drops
 * the cache so the next message from the domain starts from nothing.
 */
function IdentityTab() {
  const [rows, setRows] = useState<IdentityRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await window.electronAPI.identity?.list?.(200);
      if (r?.success && Array.isArray(r.data)) setRows(r.data as IdentityRow[]);
    } catch { /* best-effort */ }
  }, []);
  useEffect(() => {
    void load();
    const off = window.electronAPI.identity?.onUpdated?.(() => { void load(); });
    return () => { off?.(); };
  }, [load]);

  const refresh = async (domain: string) => {
    setBusy(domain);
    try { await window.electronAPI.identity?.refresh?.(domain); } finally { setBusy(null); await load(); }
  };
  const forget = async (domain: string) => {
    setBusy(domain);
    try { await window.electronAPI.identity?.forget?.(domain); } finally { setBusy(null); await load(); }
  };

  return (
    <div className="p-6 max-w-5xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Sender pictures come from, in order: the domain’s BIMI brand logo (only on mail that passed DMARC), the contact’s
        confirmed photo, the domain’s favicon, then initials. A domain whose Verified Mark Certificate chains to a Mark
        Verifying Authority for that logo earns the <BadgeCheck className="inline h-3.5 w-3.5 text-blue-600 dark:text-blue-400" aria-hidden /> verified
        tick. Lookups run once per domain in the background; turn them off under Settings → General.
      </p>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground flex items-center gap-2">
          <Info className="h-4 w-4" /> No sender domains have been looked up yet. Open a message and its domain appears here.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Domain</th>
                <th className="px-3 py-2 font-medium">Brand (BIMI)</th>
                <th className="px-3 py-2 font-medium">Favicon</th>
                <th className="px-3 py-2 font-medium">Checked</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pill = r.bimiStatus ? BIMI_PILL[r.bimiStatus] : null;
                return (
                  <tr key={r.domain} className="border-t border-border align-top">
                    {/* `break-words`, never `break-all`: break-all makes the
                        cell's min-content one character wide, so auto layout
                        is free to squeeze the column to nothing and spell the
                        domain down the page. */}
                    <td className="px-3 py-2 min-w-[12rem]">
                      <div className="flex items-center gap-2">
                        {(r.bimiLogo || r.favicon) ? (
                          <img src={r.bimiLogo ?? r.favicon ?? undefined} alt="" className="h-7 w-7 shrink-0 rounded-full bg-white object-contain p-0.5 border border-border" />
                        ) : (
                          <span className="h-7 w-7 shrink-0 rounded-full bg-muted inline-block" />
                        )}
                        <span className="font-medium break-words">{r.domain}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        {pill
                          ? <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${pill.tone}`}>{pill.label}</span>
                          : <span className="whitespace-nowrap text-xs text-muted-foreground">Not looked up</span>}
                        <Tooltip content={<BimiRecordCard row={r} label={pill?.label ?? 'Not looked up'} />} delayMs={40} maxWidth={340} position="bottom">
                          <span className="inline-flex cursor-help text-muted-foreground hover:text-foreground transition-colors" role="img" aria-label={`BIMI record for ${r.domain}`}>
                            <Info className="h-3.5 w-3.5" />
                          </span>
                        </Tooltip>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {/* faviconDetail is the only account of WHY a favicon is
                          missing, and it was being fetched and then thrown
                          away — an "Unreachable" nobody can act on. */}
                      <Tooltip content={r.faviconDetail ?? 'Not looked up yet'} delayMs={40} maxWidth={320} position="bottom" hidden={!r.faviconDetail}>
                        <span className={`whitespace-nowrap${r.faviconDetail ? ' cursor-help' : ''}`}>
                          {r.faviconStatus === 'found' ? 'Found' : r.faviconStatus === 'none' ? 'None' : r.faviconStatus === 'error' ? 'Unreachable' : 'Not looked up'}
                        </span>
                      </Tooltip>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      <div>BIMI: {when(r.bimiCheckedAt)}</div>
                      <div>Favicon: {when(r.faviconCheckedAt)}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <Tooltip content="Look this domain up again now" delayMs={40}>
                          <button onClick={() => void refresh(r.domain)} disabled={busy !== null} aria-label={`Refresh ${r.domain}`}
                            className="p-1.5 rounded-md border border-border hover:bg-muted/60 disabled:opacity-50 transition-colors">
                            {busy === r.domain ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                          </button>
                        </Tooltip>
                        <Tooltip content="Forget what is cached for this domain" delayMs={40}>
                          <button onClick={() => void forget(r.domain)} disabled={busy !== null} aria-label={`Forget ${r.domain}`}
                            className="p-1.5 rounded-md border border-border hover:bg-muted/60 disabled:opacity-50 transition-colors">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- Spam */

interface JudgedRow {
  id: string;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  date: number;
  folderPath: string;
  tags: string;
  spamScore: number | null;
  spamReasons: string | null;
  spamUserVerdict: 'spam' | 'ham' | null;
}

/**
 * Everything the spam filter had an opinion on — filed, merely suspicious, or
 * overruled by you — with the score and every reason, so a verdict is never a
 * bare adjective. "Not spam" un-files the message and stores your word, which
 * the filter respects from then on; "Spam" files it and adds the sender to
 * your blocked list. Both go through the same action as the message menu.
 */
function SpamTab() {
  const [rows, setRows] = useState<JudgedRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await window.electronAPI.spam?.listJudged?.(200);
      if (r?.success && Array.isArray(r.data)) setRows(r.data as JudgedRow[]);
    } catch { /* best-effort */ }
  }, []);
  useEffect(() => {
    void load();
    const off = window.electronAPI.spam?.onReputationProgress?.(() => { void load(); });
    return () => { off?.(); };
  }, [load]);

  const decide = async (id: string, verdict: 'spam' | 'ham') => {
    setBusy(id);
    try {
      const res = await window.electronAPI.spam?.setUserVerdict?.(id, verdict);
      // Reporting a sender withdraws their trust in main: re-read the list so
      // their other mail stops counting as trusted (shield, remote images).
      if (verdict === 'spam' && res?.success) void reloadTrustedSenders();
    } finally { setBusy(null); await load(); }
  };

  const filed = rows.filter((r) => r.tags.includes('|spam|') && r.spamUserVerdict !== 'ham').length;
  const overruled = rows.filter((r) => r.spamUserVerdict === 'ham').length;

  return (
    <div className="p-6 max-w-5xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Messages the spam filter scored as suspicious or spam, and the ones you have ruled on. Scores come from the headers
        (authentication, a spoofed name, a forged reply…), then from sender and link reputation once the network has been asked.
        Your verdict outranks any score: a message you mark <b>Not spam</b> is never filed again.
      </p>
      <div className="flex flex-wrap gap-4 text-sm">
        <span className="rounded-lg border border-border bg-card px-3 py-2"><b>{filed}</b> filed as spam</span>
        <span className="rounded-lg border border-border bg-card px-3 py-2"><b>{rows.length - filed - overruled}</b> suspicious, left in place</span>
        <span className="rounded-lg border border-border bg-card px-3 py-2"><b>{overruled}</b> overruled by you</span>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground flex items-center gap-2">
          <Info className="h-4 w-4" /> Nothing yet — the filter has had no reason to doubt any message it has seen.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Message</th>
                <th className="px-3 py-2 font-medium">Score</th>
                <th className="px-3 py-2 font-medium">Why</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const verdict = spamVerdict(r.spamScore);
                const reasons = parseSpamReasons(r.spamReasons);
                const isFiled = r.tags.includes('|spam|') && r.spamUserVerdict !== 'ham';
                const scoreTone = r.spamUserVerdict === 'ham' ? 'bg-muted text-muted-foreground'
                  : verdict === 'spam' || r.spamUserVerdict === 'spam' ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                  : 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
                return (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="px-3 py-2 min-w-0">
                      <div className="font-medium truncate max-w-[22rem]">{r.subject || '(no subject)'}</div>
                      <div className="text-xs text-muted-foreground truncate max-w-[22rem]">{r.fromName ? `${r.fromName} <${r.fromAddress}>` : r.fromAddress}</div>
                      <div className="text-xs text-muted-foreground">{new Date(r.date * 1000).toLocaleString()} · {r.folderPath}</div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${scoreTone}`}>
                        {r.spamUserVerdict === 'ham' ? 'Not spam (you)' : r.spamUserVerdict === 'spam' ? 'Spam (you)' : isFiled ? `Spam · ${r.spamScore ?? '–'}` : `Suspicious · ${r.spamScore ?? '–'}`}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {reasons.length === 0 ? <span>No stored reasons{r.tags.includes('|spam|') ? ' — tagged by the AI categoriser' : ''}</span> : (
                        <ul className="space-y-0.5">
                          {reasons.slice(0, 4).map((x, i) => <li key={`${x.id}-${i}`}><span className="font-medium text-foreground/80">+{x.points}</span> {x.detail}</li>)}
                          {reasons.length > 4 && <li>+{reasons.length - 4} more</li>}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        {r.spamUserVerdict !== 'ham' && (
                          <Tooltip content="Not spam: un-file it and never file it again" delayMs={40}>
                            <button onClick={() => void decide(r.id, 'ham')} disabled={busy !== null} aria-label="Not spam"
                              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted/60 disabled:opacity-50 transition-colors">
                              {busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Not spam
                            </button>
                          </Tooltip>
                        )}
                        {r.spamUserVerdict !== 'spam' && !isFiled && (
                          <Tooltip content="Spam: file it and block the sender" delayMs={40}>
                            <button onClick={() => void decide(r.id, 'spam')} disabled={busy !== null} aria-label="Spam"
                              className="inline-flex items-center gap-1 rounded-md border border-red-500/40 px-2 py-1 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10 disabled:opacity-50 transition-colors">
                              <Ban className="h-3.5 w-3.5" /> Spam
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <TrustedSendersPanel />
    </div>
  );
}
