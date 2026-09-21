import { parseSpamReasons, spamVerdict } from '@sarv-in/email-spam-scan/verdict';
import { ShieldCheck, Shield, ShieldQuestion, ShieldAlert, ShieldX, Trash2, Link2, Image as ImageIcon, UserX, Info, Loader2, BadgeCheck, RefreshCw, Ban, Check } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { getRemoteImageMode } from '../../store/helpers';
import { LEVEL_COPY, type SecurityLevel } from '../../utils/email-security';
import { removeLinkRule, useLinkRules, type LinkRule } from '../../utils/security-rules';
import { useConfirm } from '../ConfirmDialog';
import { BlockedSendersPanel } from '../settings/BlockedSendersPanel';
import { Tooltip } from '../Tooltip';

import { BlocklistsTab } from './BlocklistsTab';

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

const PROTECTIONS: Array<{ title: string; detail: string }> = [
  { title: 'Isolated message rendering', detail: 'Every email body renders inside a sandboxed frame. Scripts, stylesheets, fonts and imports are stripped before it loads.' },
  { title: 'Links open in your browser', detail: 'Clicking a link never navigates inside the app — it hands the address to your system browser with referrer and opener stripped.' },
  { title: 'Sender authentication', detail: 'SPF, DKIM and DMARC verdicts are read from the receiving server’s Authentication-Results header and shown on the shield beside each sender.' },
  { title: 'Impersonation checks', detail: 'A display name that names one domain while the message came from another, and links whose text says one domain while pointing to another, are flagged.' },
  { title: 'Brand verification (BIMI)', detail: 'A sender domain’s published logo is shown only on mail that passed DMARC, and the blue verified tick only when its Verified Mark Certificate chains to a pinned Mark Verifying Authority for that exact logo and domain. Details per domain under Sender identity.' },
  { title: 'Sender reputation', detail: 'After a message arrives, its sending server’s address and its sender domains are checked against spam blocklists — through Sarv’s reputation service with your own sign-in, or local DNS blocklists if you choose — and a listing adds to the spam score. Off, local or Sarv under Settings → General.' },
  { title: 'Spam filter', detail: 'Every arriving message is scored from its headers before the AI sees it — failed authentication, a spoofed sender name, a forged reply, missing or mis-dated headers, bulk mail with no unsubscribe, your mail server’s own spam verdict, and senders you have reported. A message over the line is filed as spam with its reasons shown on the shield.' },
  { title: 'Encrypted mail cache', detail: 'The local mailbox database is encrypted at rest; the key lives in the operating system keychain.' },
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

/**
 * Where the spam filter's reputation stage stands: which provider, how many
 * messages still await a verdict, and anything a provider said it could not
 * answer — a Spamhaus refusal through a public resolver, no Sarv sign-in.
 */
function ReputationStatus() {
  const [state, setState] = useState<{ pending: number; judged: number; filed: number; provider: string | null; notes: string[]; running: boolean; lastRun: number | null } | null>(null);
  useEffect(() => {
    const api = window.electronAPI.spam;
    api?.getReputationState?.().then((r) => { if (r?.success && r.data) setState(r.data); }).catch(() => { /* best-effort */ });
    const off = api?.onReputationProgress?.((s) => setState(s));
    return () => { off?.(); };
  }, []);
  if (!state) return null;
  const providerLabel = state.provider === 'sarv' ? 'Sarv reputation service' : state.provider === 'local-dnsbl' ? 'local DNS blocklists' : null;
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex items-start gap-3 text-sm">
      {state.running ? <Loader2 className="h-4 w-4 mt-0.5 animate-spin text-primary flex-shrink-0" /> : <ShieldCheck className="h-4 w-4 mt-0.5 text-green-600 dark:text-green-400 flex-shrink-0" />}
      <div className="min-w-0 flex-1">
        {providerLabel ? (
          <span>
            Sender reputation via <b>{providerLabel}</b>: {state.judged.toLocaleString()} message{state.judged === 1 ? '' : 's'} judged this session,
            {' '}{state.filed.toLocaleString()} filed as spam by it, {state.pending.toLocaleString()} waiting.
          </span>
        ) : (
          <span>Sender reputation checks are off, or the Sarv service address is not set — messages are judged from their headers alone. Change this under Settings → General.</span>
        )}
        {state.notes.length > 0 && (
          <ul className="mt-1 text-xs text-muted-foreground list-disc pl-4">
            {state.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      </div>
      {providerLabel && (
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
          {PROTECTIONS.map((p) => (
            <div key={p.title} className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2 font-medium">
                <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400" />
                {p.title}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">{p.detail}</div>
            </div>
          ))}
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

const MODE_COPY: Record<'block' | 'safe' | 'always', { title: string; detail: string }> = {
  block: { title: 'Block remote images', detail: 'Nothing is fetched until you click “Load images”. Senders cannot tell when you open their mail.' },
  safe: { title: 'Load except promotions and spam', detail: 'Images load automatically unless the AI has filed the message as promotional or spam.' },
  always: { title: 'Always load', detail: 'Every remote image loads on open. Senders with tracking pixels learn when and where you read.' },
};

function ImagesTab() {
  const [mode, setMode] = useState<'block' | 'safe' | 'always'>('safe');
  const [allowed, setAllowed] = useState<string[]>([]);
  const { confirm, confirmDialog } = useConfirm();

  const load = async () => {
    setMode(getRemoteImageMode());
    try {
      const res = await window.electronAPI.emails.getImageAllowedSenders();
      if (res?.success && Array.isArray(res.data)) setAllowed([...res.data].sort());
    } catch { /* best-effort */ }
  };
  useEffect(() => { void load(); }, []);

  const revoke = async (address: string) => {
    const ok = await confirm({
      title: 'Stop auto-loading images?',
      message: `${address}\n\nImages from this sender will be blocked again until you choose “Load images” on a message.`,
      confirmLabel: 'Stop auto-loading',
    });
    if (!ok) return;
    await window.electronAPI.emails.disallowImagesForSender?.(address);
    await load();
  };

  const m = MODE_COPY[mode];
  return (
    <div className="p-6 max-w-4xl space-y-8">
      {confirmDialog}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">Current policy</h2>
        <div className="rounded-lg border border-border bg-card p-4 flex items-start gap-3">
          <ImageIcon className="h-5 w-5 mt-0.5 text-primary flex-shrink-0" />
          <div>
            <div className="font-medium">{m.title}</div>
            <div className="text-sm text-muted-foreground">{m.detail}</div>
            <div className="mt-2 text-xs text-muted-foreground">Change this under Settings → Inbox → Remote images.</div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Senders allowed to load images <span className="text-muted-foreground/70 font-normal">({allowed.length})</span>
        </h2>
        {allowed.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No per-sender allowances. Clicking “Load images” on a message adds its sender here.
          </div>
        ) : (
          <div className="rounded-lg border border-border divide-y divide-border">
            {allowed.map((a) => (
              <div key={a} className="flex items-center gap-3 px-3 py-2 text-sm">
                <UserX className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate">{a}</span>
                <Tooltip content="Stop auto-loading" delayMs={40}>
                  <button
                    onClick={() => revoke(a)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    aria-label={`Stop auto-loading images from ${a}`}
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
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {(r.bimiLogo || r.favicon) ? (
                          <img src={r.bimiLogo ?? r.favicon ?? undefined} alt="" className="h-7 w-7 rounded-full bg-white object-contain p-0.5 border border-border" />
                        ) : (
                          <span className="h-7 w-7 rounded-full bg-muted inline-block" />
                        )}
                        <span className="font-medium break-all">{r.domain}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {pill ? <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${pill.tone}`}>{pill.label}</span> : <span className="text-muted-foreground">Not looked up</span>}
                      {r.bimiOrganization && <div className="mt-1 text-xs">{r.bimiOrganization}{r.bimiIssuer ? ` — issued by ${r.bimiIssuer}` : ''}</div>}
                      {r.bimiDetail && <div className="mt-0.5 text-xs text-muted-foreground break-words">{r.bimiDetail}</div>}
                      {r.dmarcPolicy && <div className="mt-0.5 text-xs text-muted-foreground">DMARC p={r.dmarcPolicy}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {r.faviconStatus === 'found' ? 'Found' : r.faviconStatus === 'none' ? 'None' : r.faviconStatus === 'error' ? 'Unreachable' : 'Not looked up'}
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
    try { await window.electronAPI.spam?.setUserVerdict?.(id, verdict); } finally { setBusy(null); await load(); }
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
    </div>
  );
}
