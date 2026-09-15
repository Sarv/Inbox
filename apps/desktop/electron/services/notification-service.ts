/**
 * New-mail OS notifications (main process).
 *
 * Fires from the pipeline AFTER categorisation so the AI verdict (important /
 * needs-response) is known — the default mode is `important`. Runs in the main
 * process so it works when the window is backgrounded and for background
 * accounts on IDLE.
 *
 * Design guarantees:
 *  - BACKFILL-SAFE: only mail whose date is newer than app-launch is ever
 *    notified, so the large-mailbox history/backfill (which inserts OLD mail)
 *    can never trigger a ping storm.
 *  - COALESCED: a burst collapses into one summary toast, and the sound is
 *    rate-limited so it never machine-guns.
 *  - FOCUS-AWARE: suppressed when the window is focused on that exact
 *    account+folder (you're already looking at it).
 *
 * Send-failures / reauth / sync-state stay on the in-app banner channel — this
 * service is ONLY for new inbound mail.
 */
import { createLogger, getEventBus } from '@sarvinbox/core';
import { Notification } from 'electron';

import { getMainWindow } from '../shared';

const logger = createLogger('notifications');

type NotifMode = 'off' | 'important' | 'all';

interface NotifConfig {
  mode: NotifMode;
  sound: boolean;
  /** Per-account: whether to notify + a display label (email/name). Also gives
   *  the account COUNT — we only show which account a mail hit when > 1. */
  accounts: Record<string, { notify: boolean; label: string }>;
  /** What the focused window is currently showing — to suppress self-pings. */
  view: { accountId: string | null; folderId: string | null };
  /** Working-hours schedule (local time). Inside it → notify with sound; outside
   *  it → the toast still shows but SILENT. `days` are 0=Sun..6=Sat; start/end are
   *  "HH:MM". Disabled → always allowed to sound. */
  workingHours: { enabled: boolean; days: number[]; start: string; end: string };
}

let config: NotifConfig = {
  mode: 'important',
  sound: true,
  accounts: {},
  view: { accountId: null, folderId: null },
  workingHours: { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
};

// Mail older than this (app launch, epoch seconds) is history/backfill — never
// notified. Captured at module load (main process starts at app launch).
const SERVICE_STARTED_AT = Math.floor(Date.now() / 1000);

const COALESCE_MS = 5_000;      // buffer window: collapse a burst into one flush
const SUMMARY_THRESHOLD = 3;    // >= this many in a flush -> one summary toast
const SOUND_MIN_GAP_MS = 3_000; // rate-limit the sound across flushes

interface PendingItem { accountId: string; sender: string; subject: string; emailId: string; }
let buffer: PendingItem[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastSoundAt = 0;

/** Renderer pushes the live settings + current view here (on start + on change). */
export function setNotificationConfig(patch: Partial<NotifConfig>): void {
  config = {
    mode: patch.mode ?? config.mode,
    sound: patch.sound ?? config.sound,
    accounts: patch.accounts ?? config.accounts,
    view: patch.view ?? config.view,
    workingHours: patch.workingHours ?? config.workingHours,
  };
}

/** True when NOW (local time) is inside the working-hours window, or when the
 *  schedule is disabled. Outside it, notifications stay SILENT (no sound). */
function withinWorkingHours(): boolean {
  const wh = config.workingHours;
  if (!wh?.enabled) return true;
  const now = new Date();
  if (Array.isArray(wh.days) && wh.days.length && !wh.days.includes(now.getDay())) return false;
  const toMin = (hhmm: string): number => {
    const [h, m] = (hhmm || '').split(':').map((n) => parseInt(n, 10));
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = toMin(wh.start);
  const end = toMin(wh.end);
  // Same-day window (09:00–18:00) or an overnight one (22:00–06:00).
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

export interface NewMailNotice {
  emailId: string;
  accountId: string;
  fromName?: string | null;
  fromAddress: string;
  subject?: string | null;
  date: number;              // epoch seconds
  /** AI slugs — includes 'important' / 'needs_response'. UNDEFINED on the arrival
   *  path (AI hasn't run yet): 'all' mode notifies anyway; 'important' mode waits
   *  for the post-categorisation call where this is populated. */
  categories?: string[];
  tags?: string;             // |-delimited; used to exclude Sent/Spam/Trash
  folderId?: string | null;  // for focus suppression
}

// Emails already notified this session — dedupe the arrival path ('all') against
// the post-categorisation path ('important') so a mail never pings twice.
const notified = new Set<string>();

const NON_INBOUND_RE = /\|(sent|drafts|spam|trash|\[gmail\]\/sent mail|\[gmail\]\/spam|\[gmail\]\/trash)\|/i;

/** Run the rule chain for one just-categorised mail; buffer it if it survives. */
export function notifyNewMail(m: NewMailNotice): void {
  // notifyNewMail runs ONCE PER EMAIL from the pipeline — on a large sync/backfill
  // that's thousands of calls. These "consider"/"skip" lines are per-item detail,
  // so they belong at TRACE (off even at the default 'debug' level); emitting them
  // at info previously wrote thousands of synchronous console+file lines on the
  // main thread and stalled the event loop into a permanent rainbow-loader hang.
  // The isLevelEnabled guard also skips building the string when trace is off.
  const drop = (reason: string) => {
    if (logger.isLevelEnabled('trace')) logger.trace(`[notifications] skip ${m.emailId}: ${reason} (mode=${config.mode})`);
  };
  try {
    if (logger.isLevelEnabled('trace')) {
      logger.trace(`[notifications] consider ${m.emailId} mode=${config.mode} cats=${m.categories ? `[${m.categories.join(',')}]` : 'none'} date=${m.date} from=${m.fromAddress}`);
    }
    if (config.mode === 'off') return drop('mode=off');
    if (notified.has(m.emailId)) return drop('already notified');
    // Backfill-safe: only mail that arrived AFTER launch. History/backfill mail
    // carries old dates and is dropped here — the whole ping-storm guard.
    // Normalise to epoch SECONDS (tolerate a caller passing milliseconds).
    const dateSec = m.date > 1e12 ? Math.floor(m.date / 1000) : m.date;
    if (!dateSec || dateSec < SERVICE_STARTED_AT) return drop(`older than launch (${dateSec} < ${SERVICE_STARTED_AT})`);
    // Inbound only.
    if (NON_INBOUND_RE.test(m.tags || '')) return drop('not inbound (sent/spam/trash)');
    // Per-account opt-out (default on when the account isn't in the map yet).
    if (config.accounts[m.accountId]?.notify === false) return drop(`account ${m.accountId} notify=off`);
    // Mode filter. 'all' fires regardless of AI (arrival path is fine). Only
    // 'important' needs the AI verdict: on the arrival path categories are
    // UNDEFINED, so we bail and let the post-categorisation call decide.
    if (config.mode === 'important') {
      if (!m.categories) return drop('important mode, AI not run yet (waiting for post-cat)');
      const important = m.categories.includes('important') || m.categories.includes('needs_response');
      if (!important) return drop('important mode, mail not important');
    }
    // Focus/DND: don't ping for mail you're actively looking at.
    const win = getMainWindow();
    if (
      win && !win.isDestroyed() && win.isFocused() &&
      config.view.accountId === m.accountId &&
      (!config.view.folderId || config.view.folderId === m.folderId)
    ) {
      return drop('window focused on this account+folder');
    }
    notified.add(m.emailId);
    logger.info(`[notifications] QUEUED ${m.emailId} for a toast`);
    buffer.push({
      accountId: m.accountId,
      sender: (m.fromName || m.fromAddress || 'New mail').trim(),
      subject: (m.subject || '(no subject)').trim(),
      emailId: m.emailId,
    });
    if (!flushTimer) flushTimer = setTimeout(flush, COALESCE_MS);
  } catch (e) {
    logger.warn('notifyNewMail failed:', (e as Error).message);
  }
}

// Should the toast ALSO be mirrored inside the app window? True in dev (Electron
// is spawned by node, so macOS won't authorize native toasts) and wherever the OS
// can't show notifications (e.g. a headless Linux box with no notification
// daemon). Kept OUT of a normal packaged build so native + in-app never double up.
function wantsInAppToast(): boolean {
  return !!process.env['VITE_DEV_SERVER_URL'] || !Notification.isSupported();
}

let inAppSeq = 0;
/** Mirror a toast into the renderer, which renders it as an in-app card. */
function sendInApp(p: { title: string; body: string; subtitle?: string; accountId?: string; emailId?: string }): void {
  const win = getMainWindow();
  try { win?.webContents.send('notifications:in-app', { id: String(++inAppSeq), ...p }); } catch { /* ignore */ }
}

function flush(): void {
  flushTimer = null;
  const items = buffer;
  buffer = [];
  if (!items.length) return;

  const multiAccount = Object.keys(config.accounts).length > 1;
  const now = Date.now();
  // Outside working hours the toast still shows, but SILENT (no sound).
  const playSound = config.sound && withinWorkingHours() && now - lastSoundAt > SOUND_MIN_GAP_MS;
  if (playSound) lastSoundAt = now;

  const nativeOk = Notification.isSupported();
  const inApp = wantsInAppToast();
  logger.info(`[notifications] SHOWING ${items.length} toast(s), native=${nativeOk}, inApp=${inApp}, sound=${playSound}`);

  if (items.length >= SUMMARY_THRESHOLD) {
    // Burst -> ONE summary toast + at most one sound.
    const modeWord = config.mode === 'important' ? 'important ' : '';
    const title = `${items.length} new ${modeWord}emails`;
    const body = summarize(items, multiAccount);
    if (nativeOk) {
      const n = new Notification({ title, body, silent: !playSound });
      n.on('click', () => focusWindow());
      n.show();
    }
    if (inApp) sendInApp({ title, body });
    return;
  }

  // 1–2 mails -> individual toasts; sound only on the first.
  items.forEach((it, i) => {
    const subtitle = multiAccount ? config.accounts[it.accountId]?.label || undefined : undefined;
    if (nativeOk) {
      const n = new Notification({ title: it.sender, subtitle, body: it.subject, silent: !(playSound && i === 0) });
      n.on('click', () => openEmail(it.accountId, it.emailId));
      n.show();
    }
    if (inApp) sendInApp({ title: it.sender, body: it.subject, subtitle, accountId: it.accountId, emailId: it.emailId });
  });
}

/** "Alice, Bob and 2 more" — grouped hint of who the burst was from. */
function summarize(items: PendingItem[], multiAccount: boolean): string {
  const names = [...new Set(items.map((i) => i.sender))];
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length > 3 ? ` and ${names.length - 3} more` : '';
  if (!multiAccount) return `From ${shown}${rest}`;
  const accts = [...new Set(items.map((i) => config.accounts[i.accountId]?.label).filter(Boolean))];
  return `From ${shown}${rest}${accts.length ? ` · ${accts.join(', ')}` : ''}`;
}

function focusWindow(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function openEmail(accountId: string, emailId: string): void {
  focusWindow();
  const win = getMainWindow();
  try { win?.webContents.send('notifications:open-email', { accountId, emailId }); } catch { /* ignore */ }
}

/**
 * Fire a sample toast RIGHT NOW, bypassing the mode / working-hours / dedupe
 * gating, so the notification look can be iterated on without waiting for real
 * mail — and so "why don't I see toasts?" is easy to isolate to the OS/permission
 * layer (if this shows nothing, the app IS handing macOS a toast and the block is
 * OS-side: Focus/DND, the app's Notifications setting, or a focused-app banner
 * suppression). Returns whether the OS reports notification support.
 */
export function showTestNotification(): { supported: boolean } {
  const supported = Notification.isSupported();
  logger.info(`[notifications] TEST notification requested — isSupported=${supported}, inApp=${wantsInAppToast()}`);
  const title = 'Sarv Inbox — test notification';
  const body = 'If you can see this, notifications are working.';
  if (supported) {
    const n = new Notification({ title, body, silent: false });
    n.on('click', () => focusWindow());
    n.show();
    logger.info('[notifications] TEST notification shown (native)');
  }
  // Always mirror the test in-app when native can't be shown (dev / no OS
  // support) — that's the whole point of the button in a dev build.
  if (wantsInAppToast()) sendInApp({ title, body });
  return { supported };
}

let unsubscribeArrival: (() => void) | null = null;

/**
 * Subscribe to new-mail ARRIVAL so `all` mode can fire immediately, WITHOUT
 * waiting on (or requiring) AI categorisation. Categories are omitted on this
 * path — notifyNewMail lets `all` through and makes `important` wait for the
 * post-categorisation call instead. Call once at app start.
 */
export function startNotificationService(): void {
  if (unsubscribeArrival) return;
  try {
    logger.info('[notifications] started — subscribed to email:synced (arrival path)');
    unsubscribeArrival = getEventBus().on('email:synced' as any, (event: any) => {
      if (!event?.isNew) return;
      const e = event.email;
      logger.info(`[notifications] arrival email:synced isNew=true hasEmail=${!!e} emailId=${e?.id || event.emailId}`);
      if (!e) return;
      notifyNewMail({
        emailId: e.id || event.emailId,
        accountId: event.accountId || e.accountId || 'active',
        fromName: e.fromName,
        fromAddress: e.fromAddress,
        subject: e.subject,
        date: e.date,
        tags: e.tags,
        folderId: e.folderId,
        // categories intentionally omitted — AI hasn't run at arrival time.
      });
    });
  } catch (err) {
    logger.warn('startNotificationService failed:', (err as Error).message);
  }
}

/** Stop the coalescer + arrival subscription (shutdown). */
export function stopNotificationService(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (unsubscribeArrival) { try { unsubscribeArrival(); } catch { /* ignore */ } unsubscribeArrival = null; }
  buffer = [];
}
