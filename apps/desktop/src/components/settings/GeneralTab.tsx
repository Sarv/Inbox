import { useState } from 'react';

import { SignatureSettings } from './SignatureSettings';
import type { SettingsTabProps, AppSettings } from './types';

/** "HH:MM" (24h) time picker built from two clamped <select>s — no infinite
 *  wheel-scroll like the native <input type="time"> picker. */
function TimeSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [h = '09', m = '00'] = (value || '09:00').split(':');
  const pad = (n: number) => String(n).padStart(2, '0');
  const cls = 'px-2 py-1 rounded border border-border bg-background text-sm tabular-nums';
  return (
    <span className="inline-flex items-center gap-1">
      <select className={cls} value={h} onChange={(e) => onChange(`${e.target.value}:${m}`)} aria-label="Hour">
        {Array.from({ length: 24 }, (_, i) => pad(i)).map((hh) => <option key={hh} value={hh}>{hh}</option>)}
      </select>
      <span className="text-muted-foreground">:</span>
      <select className={cls} value={m} onChange={(e) => onChange(`${h}:${e.target.value}`)} aria-label="Minute">
        {Array.from({ length: 60 }, (_, i) => pad(i)).map((mm) => <option key={mm} value={mm}>{mm}</option>)}
      </select>
    </span>
  );
}

export function GeneralTab({ settings, updateSetting }: SettingsTabProps) {
  const [labelSync, setLabelSync] = useState<{ busy: boolean; msg: string }>({ busy: false, msg: '' });
  const [testNotifMsg, setTestNotifMsg] = useState<string | null>(null);

  const sendTestNotification = async () => {
    setTestNotifMsg('Sending…');
    try {
      const res = await window.electronAPI.notifications.test();
      if (res?.success && res.supported) {
        setTestNotifMsg('Sent. If nothing appears: check System Settings → Notifications for this app (Allow + Banners), turn off Focus/Do Not Disturb, and look in Notification Center (the app must not be the frontmost window).');
      } else if (res && res.supported === false) {
        setTestNotifMsg('This OS reports notifications are not available for the app.');
      } else {
        setTestNotifMsg(res?.error || 'Failed to send a test notification.');
      }
    } catch (e) {
      setTestNotifMsg((e as Error).message || 'Failed to send a test notification.');
    }
  };
  const applyLabelsToRecentMail = async () => {
    setLabelSync({ busy: true, msg: 'Labeling recent mail…' });
    try {
      const res = await (window.electronAPI as any)?.agent?.syncCategoryLabels?.(50);
      const d = res?.data;
      const msg = res?.success
        ? `Provisioned ${d?.provisioned ?? 0} label(s), labeled ${d?.labeled ?? 0} mail. [mirroring: ${d?.enabled ? 'on' : 'OFF'}, connected: ${d?.connected ?? 0}, gmail: ${d?.gmail ?? 0}]`
        : (res?.error || 'Failed.');
      setLabelSync({ busy: false, msg });
    } catch (e) {
      setLabelSync({ busy: false, msg: (e as Error)?.message || 'Failed.' });
    }
  };
  const removeAllLabels = async () => {
    if (!window.confirm('Delete the "Sarv Inbox" labels/folders from all your accounts? This removes them (and the categorization they carry) from the server. Your mail is not deleted.')) return;
    setLabelSync({ busy: true, msg: 'Removing Sarv Inbox labels…' });
    try {
      const res = await (window.electronAPI as any)?.agent?.removeCategoryLabels?.();
      const d = res?.data;
      setLabelSync({ busy: false, msg: res?.success ? `Removed ${d?.removed ?? 0} label(s) across ${d?.accounts ?? 0} account(s).` : (res?.error || 'Failed.') });
    } catch (e) {
      setLabelSync({ busy: false, msg: (e as Error)?.message || 'Failed.' });
    }
  };
  return (
    <div className="space-y-6">
      {/* Sync Settings */}
      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Sync Settings
        </h3>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Maximum emails per folder</div>
            <div className="text-sm text-muted-foreground">
              Number of emails to sync from each folder
            </div>
          </div>
          <select
            value={settings.maxEmailsPerFolder}
            onChange={(e) => updateSetting('maxEmailsPerFolder', Number(e.target.value))}
            className="px-3 py-1.5 bg-background border border-border rounded text-sm"
          >
            <option value={100}>100 (Fast)</option>
            <option value={250}>250</option>
            <option value={500}>500</option>
            <option value={1000}>1,000</option>
            <option value={2500}>2,500</option>
            <option value={5000}>5,000 (Slow)</option>
          </select>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Body download limit</div>
            <div className="text-sm text-muted-foreground">
              Download email bodies for the latest N emails after sync
            </div>
          </div>
          <select
            value={settings.bodyDownloadLimit}
            onChange={(e) => updateSetting('bodyDownloadLimit', Number(e.target.value))}
            className="px-3 py-1.5 bg-background border border-border rounded text-sm"
          >
            <option value={100}>100</option>
            <option value={250}>250</option>
            <option value={500}>500 (Default)</option>
            <option value={1000}>1,000</option>
            <option value={2500}>2,500</option>
            <option value={5000}>5,000</option>
          </select>
        </div>

      </div>

      {/* Display Settings */}
      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Display Settings
        </h3>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Maximum page size</div>
            <div className="text-sm text-muted-foreground">
              Show this many emails per page
            </div>
          </div>
          <select
            value={settings.emailsPerPage}
            onChange={(e) => updateSetting('emailsPerPage', Number(e.target.value))}
            className="px-3 py-1.5 bg-background border border-border rounded text-sm"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Conversation view</div>
            <div className="text-sm text-muted-foreground">
              Group emails of the same topic together
            </div>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.conversationView}
                onChange={() => updateSetting('conversationView', true)}
                className="w-4 h-4"
              />
              <span className="text-sm">On</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={!settings.conversationView}
                onChange={() => updateSetting('conversationView', false)}
                className="w-4 h-4"
              />
              <span className="text-sm">Off</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Preview pane</div>
            <div className="text-sm text-muted-foreground">
              Show email preview in the list view
            </div>
          </div>
          <select
            value={settings.previewPane}
            onChange={(e) => updateSetting('previewPane', e.target.value as AppSettings['previewPane'])}
            className="px-3 py-1.5 bg-background border border-border rounded text-sm"
          >
            <option value="right">Right side</option>
            <option value="bottom">Bottom</option>
            <option value="off">Off</option>
          </select>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Mark conversation as read</div>
            <div className="text-sm text-muted-foreground">
              Automatically mark emails as read after viewing
            </div>
          </div>
          <select
            value={settings.markAsReadDelay}
            onChange={(e) => updateSetting('markAsReadDelay', Number(e.target.value))}
            className="px-3 py-1.5 bg-background border border-border rounded text-sm"
          >
            <option value={0}>Immediately</option>
            <option value={1}>After 1 second</option>
            <option value={3}>After 3 seconds</option>
            <option value={5}>After 5 seconds</option>
            <option value={-1}>Never</option>
          </select>
        </div>
      </div>

      {/* Compose Settings */}
      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Compose Settings
        </h3>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Undo send</div>
            <div className="text-sm text-muted-foreground">
              Time to cancel a sent email
            </div>
          </div>
          <select
            value={settings.undoSendDelay}
            onChange={(e) => updateSetting('undoSendDelay', Number(e.target.value))}
            className="px-3 py-1.5 bg-background border border-border rounded text-sm"
          >
            <option value={5}>5 seconds</option>
            <option value={10}>10 seconds</option>
            <option value={20}>20 seconds</option>
            <option value={30}>30 seconds</option>
          </select>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Default reply behavior</div>
            <div className="text-sm text-muted-foreground">
              Choose default action when clicking reply
            </div>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.defaultReplyBehavior === 'reply'}
                onChange={() => updateSetting('defaultReplyBehavior', 'reply')}
                className="w-4 h-4"
              />
              <span className="text-sm">Reply</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.defaultReplyBehavior === 'replyAll'}
                onChange={() => updateSetting('defaultReplyBehavior', 'replyAll')}
                className="w-4 h-4"
              />
              <span className="text-sm">Reply all</span>
            </label>
          </div>
        </div>
      </div>

      {/* UI Settings */}
      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Interface Settings
        </h3>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Hover actions</div>
            <div className="text-sm text-muted-foreground">
              Show quick action buttons when hovering over emails
            </div>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.hoverActions}
                onChange={() => updateSetting('hoverActions', true)}
                className="w-4 h-4"
              />
              <span className="text-sm">Enable</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={!settings.hoverActions}
                onChange={() => updateSetting('hoverActions', false)}
                className="w-4 h-4"
              />
              <span className="text-sm">Disable</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Remote images</div>
            <div className="text-sm text-muted-foreground">
              Remote images can track when you open mail. <span className="font-medium">Categorized only</span> auto-loads
              them only for mail the AI has sorted into a category (excluding Promotional and Spam); uncategorized, Promotional
              and Spam mail stay behind the “Load images” banner. <span className="font-medium">Block</span> blocks everything;
              <span className="font-medium"> Always load</span> loads them everywhere.
            </div>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.remoteImageMode === 'block'}
                onChange={() => updateSetting('remoteImageMode', 'block')}
                className="w-4 h-4"
              />
              <span className="text-sm">Block</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.remoteImageMode === 'safe'}
                onChange={() => updateSetting('remoteImageMode', 'safe')}
                className="w-4 h-4"
              />
              <span className="text-sm whitespace-nowrap">Categorized only</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.remoteImageMode === 'always'}
                onChange={() => updateSetting('remoteImageMode', 'always')}
                className="w-4 h-4"
              />
              <span className="text-sm whitespace-nowrap">Always load</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-start justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Sender logos and favicons</div>
            <div className="text-sm text-muted-foreground">
              Brand logos come from the sender domain’s BIMI record and appear only on mail that passed DMARC; a domain whose
              Verified Mark Certificate checks out also gets the blue verified tick beside the sender. When a sender has no
              photo or logo, the domain’s favicon is used instead. Each is looked up once per domain in the background —
              never per message, and never from inside a message.
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.senderLogos !== false}
                onChange={(e) => updateSetting('senderLogos', e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-sm whitespace-nowrap">Brand logos and verified tick (BIMI)</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.senderFavicons !== false}
                onChange={(e) => updateSetting('senderFavicons', e.target.checked)}
                className="w-4 h-4"
              />
              <span className="text-sm whitespace-nowrap">Domain favicons</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-start justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Sender reputation checks</div>
            <div className="text-sm text-muted-foreground">
              After a message arrives, its sending server’s address and its sender domains can be checked against spam
              blocklists; a listing adds to the spam score. <span className="font-medium">Sarv service</span> asks Sarv’s
              own reputation service with your Sarv sign-in, so lookups never go to list operators from your machine
              (needs the service address). <span className="font-medium">Local DNS blocklists</span> queries Spamhaus,
              SpamCop, Barracuda, SURBL and URIBL directly from here — note that Spamhaus and URIBL refuse queries made
              through public resolvers such as Google or Cloudflare DNS. <span className="font-medium">Off</span> judges
              from headers alone.
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={settings.spamReputationMode === 'off'} onChange={() => updateSetting('spamReputationMode', 'off')} className="w-4 h-4" />
              <span className="text-sm">Off</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={settings.spamReputationMode === 'local'} onChange={() => updateSetting('spamReputationMode', 'local')} className="w-4 h-4" />
              <span className="text-sm whitespace-nowrap">Local DNS blocklists</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={(settings.spamReputationMode ?? 'sarv') === 'sarv'} onChange={() => updateSetting('spamReputationMode', 'sarv')} className="w-4 h-4" />
              <span className="text-sm whitespace-nowrap">Sarv service</span>
            </label>
            {(settings.spamReputationMode ?? 'sarv') === 'sarv' && (
              <>
                <input
                  type="url"
                  value={settings.spamReputationEndpoint ?? ''}
                  onChange={(e) => updateSetting('spamReputationEndpoint', e.target.value)}
                  placeholder="https://reputation.sarv.com"
                  aria-label="Sarv reputation service address"
                  className="w-64 rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
                <label className="flex items-start gap-2 cursor-pointer w-64">
                  <input
                    type="checkbox"
                    checked={settings.spamReputationReports === true}
                    onChange={(e) => updateSetting('spamReputationReports', e.target.checked)}
                    className="w-4 h-4 mt-0.5"
                  />
                  <span className="text-sm">
                    Share my Report spam / Not spam verdicts so they count for other Sarv Inbox users
                    <span className="block text-xs text-muted-foreground">Only the sender’s domain, its server address and your verdict are sent — never the message.</span>
                  </span>
                </label>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-start justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Mirror AI categories to my mailbox</div>
            <div className="text-sm text-muted-foreground">
              Show your AI categories as labels in your provider (Gmail, sarv webmail, other clients).
              Gmail and sarv keep mail in the Inbox with no duplication (Gmail-OAuth accounts also get category colors).
              Providers without labels use a <span className="font-medium">Sarv Inbox/</span> folder per category — pick how below.
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={!!settings.categoryLabels?.enabled}
                onChange={(e) => {
                  const next = { enabled: e.target.checked, folderMode: settings.categoryLabels?.folderMode ?? 'copy' };
                  updateSetting('categoryLabels', next);
                  (window.electronAPI as any)?.agent?.setCategoryLabels?.(next);
                }}
                className="w-4 h-4"
              />
              <span className="text-sm">Enabled</span>
            </label>
            {settings.categoryLabels?.enabled && (
              <select
                value={settings.categoryLabels?.folderMode ?? 'copy'}
                onChange={(e) => {
                  const next = { enabled: true, folderMode: e.target.value as 'copy' | 'move' };
                  updateSetting('categoryLabels', next);
                  (window.electronAPI as any)?.agent?.setCategoryLabels?.(next);
                }}
                className="text-sm border border-border rounded-md px-2 py-1 bg-background"
                title="How to file mail on providers without labels (Outlook, Yahoo, …)"
              >
                <option value="copy">Folder providers: copy (keep in Inbox, duplicates)</option>
                <option value="move">Folder providers: move (files out of Inbox)</option>
              </select>
            )}
            {settings.categoryLabels?.enabled && (
              <>
                <div className="flex items-center gap-2">
                  <button
                    onClick={applyLabelsToRecentMail}
                    disabled={labelSync.busy}
                    className="text-xs px-3 py-1.5 border border-border rounded-md hover:bg-muted/50 disabled:opacity-50"
                    title="Apply category labels to your last 50 already-categorized mails, on every connected account"
                  >
                    {labelSync.busy ? 'Applying…' : 'Apply to recent mail'}
                  </button>
                  <button
                    onClick={removeAllLabels}
                    disabled={labelSync.busy}
                    className="text-xs px-3 py-1.5 border border-border text-destructive rounded-md hover:bg-destructive/10 disabled:opacity-50"
                    title="Delete all Sarv Inbox labels/folders from every account"
                  >
                    Remove all labels
                  </button>
                </div>
                {labelSync.msg && <span className="text-xs text-muted-foreground text-right max-w-[16rem]">{labelSync.msg}</span>}
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Keyboard shortcuts</div>
            <div className="text-sm text-muted-foreground">
              Use keyboard shortcuts for common actions
            </div>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.keyboardShortcuts}
                onChange={() => updateSetting('keyboardShortcuts', true)}
                className="w-4 h-4"
              />
              <span className="text-sm">On</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={!settings.keyboardShortcuts}
                onChange={() => updateSetting('keyboardShortcuts', false)}
                className="w-4 h-4"
              />
              <span className="text-sm">Off</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Button labels</div>
            <div className="text-sm text-muted-foreground">
              How to display toolbar buttons
            </div>
          </div>
          <select
            value={settings.buttonLabels}
            onChange={(e) => updateSetting('buttonLabels', e.target.value as AppSettings['buttonLabels'])}
            className="px-3 py-1.5 bg-background border border-border rounded text-sm"
          >
            <option value="icons">Icons only</option>
            <option value="text">Text only</option>
            <option value="both">Icons and text</option>
          </select>
        </div>
      </div>

      {/* Notifications */}
      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Notifications
        </h3>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Desktop notifications</div>
            <div className="text-sm text-muted-foreground">
              Get notified when new emails arrive
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.desktopNotifications === 'all'}
                onChange={() => updateSetting('desktopNotifications', 'all')}
                className="w-4 h-4"
              />
              <span className="text-sm">All new emails</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.desktopNotifications === 'important'}
                onChange={() => updateSetting('desktopNotifications', 'important')}
                className="w-4 h-4"
              />
              <span className="text-sm">Important only</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={settings.desktopNotifications === 'off'}
                onChange={() => updateSetting('desktopNotifications', 'off')}
                className="w-4 h-4"
              />
              <span className="text-sm">Off</span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Notification sound</div>
            <div className="text-sm text-muted-foreground">
              Play a sound for new emails
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.notificationSound}
              onChange={(e) => updateSetting('notificationSound', e.target.checked)}
              className="w-4 h-4 rounded"
            />
            <span className="text-sm">Enable</span>
          </label>
        </div>

        <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6 py-3">
          <div>
            <div className="font-medium">Test notification</div>
            <div className="text-sm text-muted-foreground">
              Fire a sample toast now to confirm it appears — and to iterate on how it looks.
            </div>
            {testNotifMsg && <div className="text-xs text-muted-foreground mt-1">{testNotifMsg}</div>}
          </div>
          <button
            type="button"
            onClick={sendTestNotification}
            className="px-3 py-1.5 text-sm rounded-md border border-input hover:bg-accent transition-colors whitespace-nowrap"
          >
            Send test
          </button>
        </div>

        {/* Working hours — gate the notification SOUND to a schedule. Outside it,
            notifications still show but stay silent. */}
        {(() => {
          const wh = settings.notificationWorkingHours ?? { enabled: false, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
          const setWH = (patch: Partial<typeof wh>) => updateSetting('notificationWorkingHours', { ...wh, ...patch });
          const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const toggleDay = (d: number) => {
            const days = wh.days.includes(d) ? wh.days.filter((x) => x !== d) : [...wh.days, d].sort((a, b) => a - b);
            setWH({ days });
          };
          return (
            <div className="py-3 border-t border-border/50">
              <div className="grid grid-cols-[26rem_auto] items-center justify-between gap-6">
                <div>
                  <div className="font-medium">Working hours</div>
                  <div className="text-sm text-muted-foreground">
                    Only play a sound during these days &amp; times — outside them, notifications show silently
                  </div>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wh.enabled}
                    onChange={(e) => setWH({ enabled: e.target.checked })}
                    className="w-4 h-4 rounded"
                  />
                  <span className="text-sm">Enable</span>
                </label>
              </div>
              {wh.enabled && (
                <div className="mt-3 flex flex-col gap-3">
                  <div className="flex items-center gap-1.5">
                    {DAYS.map((label, d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => toggleDay(d)}
                        title={label}
                        className={`w-9 h-8 rounded text-xs font-medium transition-colors ${
                          wh.days.includes(d)
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted text-muted-foreground hover:bg-accent'
                        }`}
                      >
                        {label[0]}
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">From</span>
                    <TimeSelect value={wh.start} onChange={(v) => setWH({ start: v })} />
                    <span className="text-muted-foreground">to</span>
                    <TimeSelect value={wh.end} onChange={(v) => setWH({ end: v })} />
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Signature — multiple named signatures + per-context defaults */}
      <SignatureSettings settings={settings} updateSetting={updateSetting} />
    </div>
  );
}
