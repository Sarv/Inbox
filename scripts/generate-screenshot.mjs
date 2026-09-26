/**
 * Builds the README screenshot (docs/images/screenshot-inbox.png).
 *
 * It renders a static HTML replica of the mail view — same layout, tokens,
 * lucide icons and logo assets the app uses — filled with INVENTED sample
 * mail, so the picture in the README never carries anyone's real inbox.
 *
 * Usage:
 *   node scripts/generate-screenshot.mjs /tmp/shot.html
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless \
 *     --disable-gpu --hide-scrollbars --window-size=1600,1000 \
 *     --force-device-scale-factor=1.25 \
 *     --screenshot=docs/images/screenshot-inbox.png /tmp/shot.html
 *
 * Any Chromium binary works (chrome/chromium/msedge) — the flags are the same
 * on macOS, Windows and Linux; only the path to the binary differs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICONS = path.join(REPO, 'node_modules/lucide-react/dist/esm/icons');
const PUB = path.join(REPO, 'apps/desktop/public');

/* ── lucide icon → inline SVG ─────────────────────────────────────────── */
const cache = new Map();
const nodes = (name) => {
  if (!cache.has(name)) {
    const src = readFileSync(path.join(ICONS, `${name}.js`), 'utf8');
    const match = src.match(/createLucideIcon\(\s*"[^"]+",\s*(\[[\s\S]*?\])\s*\);/);
    if (!match) throw new Error(`no node array for ${name}`);
    cache.set(name, new Function(`return ${match[1]}`)());
  }
  return cache.get(name);
};
const icon = (name, size = 16, { cls = '', fill = 'none' } = {}) => {
  const body = nodes(name)
    .map(([tag, attrs]) =>
      `<${tag} ${Object.entries(attrs)
        .filter(([key]) => key !== 'key')
        .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${value}"`)
        .join(' ')} />`,
    )
    .join('');
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
};

const esc = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const dataUri = (file, mime) =>
  `data:${mime};base64,${readFileSync(path.join(PUB, file)).toString('base64')}`;
const logoMark = dataUri('icon.svg', 'image/svg+xml');
const wordmark = dataUri('wordmark.svg', 'image/svg+xml');
const sarvLogo = dataUri('sarv.png', 'image/png');

/* ── sample data ──────────────────────────────────────────────────────── */
const navItems = [
  { icon: 'inbox', label: 'Inbox', count: '2', active: true },
  { icon: 'mail', label: 'All Email' },
  { icon: 'star', label: 'Starred' },
  { icon: 'clock', label: 'Snoozed' },
  { icon: 'send', label: 'Outbox' },
];
const systemItems = [
  { icon: 'send', label: 'Sent' },
  { icon: 'file-text', label: 'Drafts' },
  { icon: 'ban', label: 'Spam' },
  { icon: 'trash-2', label: 'Trash' },
];
const labels = [
  { name: 'Clients', color: '#2563eb' },
  { name: 'Design', color: '#a855f7' },
  { name: 'Receipts', color: '#16a34a' },
];
const folders = ['Archive 2025', 'Contracts', 'Deliveries', 'Finance', 'Hiring', 'Newsletters', 'Travel'];

const chips = [
  { icon: null, label: 'All', active: true },
  { icon: 'star', label: 'Important' },
  { icon: 'message-circle', label: 'Needs Response' },
  { icon: 'bell', label: 'Reminders' },
  { icon: 'calendar', label: 'Meetings' },
  { icon: 'receipt', label: 'Invoices' },
  { icon: 'credit-card', label: 'Finance' },
  { icon: 'tag', label: 'Promotions' },
];

const important = [
  {
    sender: 'Hannah Weiss', count: '4', starred: false, unread: true,
    subject: 'Re: [#326249] Issue report — sheet data, undo & auto-save',
    preview: 'Hi Tom, yes — I have the staging build now. The undo stack still resets when a sheet auto-saves mid-edit, so…',
    time: '2:25 PM',
  },
  {
    sender: 'Clara Boyd', starred: false, unread: true,
    subject: 'Updated invitation: R2 interview @ Fri Sep 25, 2026 4:00pm – 4:30pm (IST)',
    preview: 'This event has been updated. Joining info: meet.example.com/abc-defg — the panel is now three people…',
    tag: { label: 'Meetings', tone: 'green', icon: 'calendar' }, attach: true,
    time: '1:05 PM',
  },
];

const starred = [
  {
    sender: 'Priya Menon .. Alex Rivera', count: '9', starred: true, unread: true,
    subject: 'Text editor meeting follow-up',
    preview: 'Hi Alex, kindly point your integration at the staging endpoint before Friday: https://preprod-web.example…',
    tag: { label: 'Reminders', tone: 'blue', icon: 'bell' },
    time: '2:19 PM',
  },
  {
    sender: 'Daniel Okafor', count: '13', starred: true,
    subject: 'Production server details for the new MTA',
    preview: 'Thanks Sam — I have access now. On Thu, Sep 3, 2026 at 5:36 PM Sam Whitfield <sam@example.com> wrote…',
    time: 'Sep 3',
  },
  {
    sender: 'Ravi Chandran', starred: true,
    subject: 'Fwd: Identity portal access',
    preview: '---------- Forwarded message --------- From: Ravi Chandran <ravi@example.com> Date: Tue, Jan 23, 2026',
    time: 'Aug 17',
  },
  {
    sender: 'Ana .. Deepak', count: '65', starred: true,
    subject: 'Single sign-on between mail and the identity provider — development work',
    preview: 'Hello team, please find the updated work ID and the session notes from this morning attached below…',
    time: 'Aug 11',
  },
  {
    sender: 'noreply@tracker.example', count: '5', starred: true,
    subject: '[WRK-1365] Lena Fischer updated this task',
    preview: 'Update on WRK-1365 — Hi Sam, you are watching WRK-1365. Lena Fischer commented on the acceptance…',
    tag: { label: 'Reminders', tone: 'blue', icon: 'bell' },
    time: 'Aug 5',
  },
  {
    sender: 'MailProbe', starred: true,
    subject: 'MailProbe.example — test delivery ID: 8f2c41ab9d76',
    preview: 'If you are reading this, your email address is working. This message was sent by the delivery probe…',
    time: 'Jul 24',
  },
  {
    sender: 'Iris .. Sam', count: '2', starred: true,
    subject: 'OAuth integration in the workspace',
    preview: 'Hi Iris, as we implement the first draft of sign-in we are good here, and in the meantime I will…',
    time: 'Jul 16',
  },
  {
    sender: 'Owen Blake', starred: true,
    subject: 'Staging access',
    preview: 'Host = staging.example.com, Port = 2075, User = deploy-bot. Request the key through the access portal…',
    time: 'Jul 7',
  },
  {
    sender: 'Maya Lindqvist', starred: true,
    subject: 'Fwd: FW: [EXT] Security sprint | Weekly update | Every Monday – 12:00 PM to 1:00 PM',
    preview: 'FYI — Maya Lindqvist, Product Specialist, +1 555 0142. Original invite attached for the whole quarter…',
    attach: true,
    time: 'Mar 2',
  },
];

const everything = [
  {
    sender: 'noreply@tracker.example',
    subject: '[WRK-2328] @Sam Reyes mentioned you',
    preview: 'Lena Fischer mentioned you — Hi Sam, Lena mentioned you on WRK-2328 in a comment about the retry…',
    tag: { label: 'Reminders', tone: 'blue', icon: 'bell' },
    time: '2:42 PM',
  },
  {
    sender: 'noreply@tracker.example',
    subject: '[WRK-2328] Lena Fischer updated this task',
    preview: 'Update on WRK-2328 — Hi Sam, you are watching WRK-2328. Lena changed the status to In Review…',
    tag: { label: 'Reminders', tone: 'blue', icon: 'bell' },
    time: '2:42 PM',
  },
  {
    sender: 'Tom Alvarez', unread: true,
    subject: 'Invoice INV-2026-0418 is ready',
    preview: 'Your September invoice is attached. Amount due $1,240.00 by 10 October 2026. Pay online at…',
    tag: { label: 'Invoices', tone: 'amber', icon: 'receipt' }, attach: true,
    time: '11:18 AM',
  },
  {
    sender: 'Rakesh Nair',
    subject: 'File shared: Workspace_design_register.docx',
    preview: 'FILE SHARING NOTIFICATION — A file has been shared with you. Hello Sam, Rakesh Nair shared…',
    time: '10:04 AM',
  },
  {
    sender: 'Market Buzz',
    subject: 'Why fintech and insurtech shares slid this week',
    preview: '25 September 2026 — View in browser ( https://news.example.com/story/estored/161/55434 )…',
    time: '8:39 AM',
  },
  {
    sender: 'DevWeekly', unread: true,
    subject: 'See how 16 agent memory systems stack up',
    preview: '86.5% accuracy at ~$0.07 per session. Persistent memory is the #2 barrier organizations report…',
    time: '8:01 AM',
  },
  {
    sender: 'Craft Ideas',
    subject: 'Obsessed with these 12 weekend projects',
    preview: 'To view this content, open the following URL in your browser: https://mail.example.com/c/651…',
    time: 'Sep 24',
  },
  {
    sender: 'Nora Feldman', count: '3',
    subject: 'Re: Quarterly roadmap — where we landed',
    preview: 'Thanks everyone. Recapping the three decisions so nobody has to reread the thread: first, we…',
    time: 'Sep 24',
  },
];

/* ── markup helpers ───────────────────────────────────────────────────── */
const navRow = ({ icon: name, label, count, active }) => `
  <div class="nav-row${active ? ' nav-active' : ''}">
    ${icon(name, 16)}<span class="nav-label">${label}</span>
    ${count ? `<span class="nav-count">${count}</span>` : ''}
  </div>`;

const sectionLabel = (text, plus = false) => `
  <div class="sec-label">${icon('chevron-down', 14)}<span>${text}</span>${plus ? `<span class="sec-plus">${icon('plus', 14)}</span>` : ''}</div>`;

const tagChip = (tag) =>
  `<span class="tag tag-${tag.tone}">${icon(tag.icon, 11)}${tag.label}</span>`;

const listRow = (row) => `
  <div class="row">
    <span class="row-check">${icon('square', 16)}</span>
    <span class="row-star">${
      row.starred
        ? icon('star', 16, { cls: 'star-on', fill: 'currentColor' })
        : icon('star', 16, { cls: 'star-off' })
    }</span>
    <span class="sender${row.unread ? ' unread' : ''}">
      <span class="sender-name">${esc(row.sender)}</span>
      ${row.count ? `<span class="sender-count">(${row.count})</span>` : ''}
    </span>
    <span class="subject-wrap">
      <span class="subject${row.unread ? ' unread' : ''}">${esc(row.subject)}</span>
      <span class="dash">-</span>
      <span class="preview">${esc(row.preview)}</span>
    </span>
    <span class="meta">
      ${row.tag ? tagChip(row.tag) : ''}
      ${row.attach ? icon('paperclip', 15, { cls: 'attach' }) : ''}
      <span class="time">${row.time}</span>
    </span>
  </div>`;

const sectionHeader = (label, count) => `
  <div class="sec-head">
    ${icon('chevron-down', 16, { cls: 'muted' })}
    <span class="sec-head-label">${label}</span>
    <span class="sec-head-right"><span class="sec-count">${count}</span>${icon('more-vertical', 16, { cls: 'muted' })}</span>
  </div>`;

const chipEl = (chip) => `
  <span class="chip${chip.active ? ' chip-active' : ''}">${chip.icon ? icon(chip.icon, 12) : ''}${chip.label}</span>`;

const railItem = (name, active = false) =>
  `<div class="rail-item${active ? ' rail-active' : ''}">${icon(name, 20)}</div>`;

/* ── page ─────────────────────────────────────────────────────────────── */
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root{
  --background:#ffffff; --foreground:#0f172a; --muted:#f1f5f9; --muted-fg:#64748b;
  --border:#e2e8f0; --primary:#2563eb; --primary-soft:#e7effd; --accent:#f1f5f9;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1600px;height:1000px;overflow:hidden}
body{
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
  font-size:14px;color:var(--foreground);background:var(--background);display:flex;
  -webkit-font-smoothing:antialiased;
}
.ic{flex:0 0 auto}
.muted{color:var(--muted-fg)}

/* ── app rail ── */
.rail{width:56px;flex:0 0 56px;display:flex;flex-direction:column;
  background:rgba(241,245,249,.35);border-right:1px solid var(--border)}
.rail-logo{height:56px;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid var(--border)}
.rail-logo img{width:32px;height:32px;object-fit:contain}
.rail-items{flex:1;padding:8px 0}
.rail-item{display:flex;align-items:center;padding:12px 18px;color:var(--muted-fg)}
.rail-active{background:rgba(37,99,235,.10);color:var(--primary)}
.rail-bottom{padding-bottom:6px}

/* ── sidebar ── */
.sidebar{width:256px;flex:0 0 256px;display:flex;flex-direction:column;
  border-right:1px solid var(--border);background:#fff}
.sb-head{height:56px;display:flex;align-items:center;justify-content:center;gap:10px;
  border-bottom:1px solid var(--border)}
.sb-head img.mark{height:40px;width:40px;object-fit:contain}
.sb-head img.word{height:20px;width:auto;object-fit:contain}
.acct{margin:12px 12px 0;display:flex;align-items:center;gap:8px;padding:8px 10px;
  border:1px solid var(--border);border-radius:6px}
.avatar{height:24px;width:24px;border-radius:999px;background:var(--primary);color:#fff;
  font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:0 0 auto}
.acct-mail{flex:1;min-width:0;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.compose{margin:12px;display:flex;align-items:center;justify-content:center;gap:8px;
  padding:10px 16px;background:var(--primary);color:#fff;border-radius:999px;font-weight:500;
  box-shadow:0 4px 6px -1px rgba(15,23,42,.12),0 2px 4px -2px rgba(15,23,42,.10)}
.sb-scroll{flex:1;overflow:hidden;padding:0 8px}
.nav-row{display:flex;align-items:center;gap:12px;padding:8px 12px;border-radius:6px;color:var(--foreground)}
.nav-label{flex:1;min-width:0;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-count{font-size:12px;color:var(--muted-fg)}
.nav-active{background:var(--primary-soft);font-weight:500}
.sec-label{display:flex;align-items:center;gap:8px;padding:6px 12px;margin-top:4px;
  font-size:12px;font-weight:600;color:var(--muted-fg);text-transform:uppercase;letter-spacing:.05em}
.sec-plus{margin-left:auto;display:flex}
.label-row{display:flex;align-items:center;gap:8px;padding:8px 12px 8px 32px}
.dot{height:12px;width:12px;border-radius:999px;flex:0 0 auto}
.label-name{font-size:14px}
.quota{padding:6px 12px;border-top:1px solid var(--border)}
.quota-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;
  font-size:11px;color:var(--muted-fg)}
.quota-bar{height:4px;border-radius:999px;background:var(--muted);overflow:hidden}
.quota-fill{height:100%;background:var(--primary);width:14%}
.statusbar{display:flex;align-items:center;justify-content:space-between;gap:8px;
  padding:6px 12px;border-top:1px solid var(--border);font-size:12px;color:var(--muted-fg)}
.status-right{display:flex;align-items:center;gap:8px}
.live-dot{height:8px;width:8px;border-radius:999px;background:#22c55e}

/* ── main ── */
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.searchbar{padding:12px 16px;border-bottom:1px solid var(--border)}
.search{position:relative;display:flex;align-items:center}
.search .s-ic{position:absolute;left:12px;color:var(--muted-fg);display:flex}
.search .f-ic{position:absolute;right:12px;color:var(--muted-fg);display:flex}
.search input{width:100%;padding:8px 40px;border:1px solid var(--border);border-radius:999px;
  font:inherit;font-size:14px;background:#fff}
.search input::placeholder{color:var(--muted-fg)}
.listhead{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border);color:var(--muted-fg)}
.listhead .right{margin-left:auto;display:flex;align-items:center;gap:10px}
.chips{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--border);
  background:rgba(241,245,249,.35)}
.chip{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:12px;
  font-weight:500;color:var(--muted-fg);border:1px solid transparent;white-space:nowrap}
.chip-active{background:var(--primary);color:#fff;padding:5px 16px}
.list{flex:1;overflow:hidden}
.sec-head{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--muted);
  border-bottom:1px solid var(--border)}
.sec-head-label{font-size:14px;font-weight:500}
.sec-head-right{margin-left:auto;display:flex;align-items:center;gap:6px}
.sec-count{font-size:12px;color:var(--muted-fg);font-variant-numeric:tabular-nums}
.empty{padding:12px 16px;font-size:14px;font-style:italic;color:var(--muted-fg);border-bottom:1px solid var(--border)}
.row{height:40px;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid var(--border)}
.row-check{color:var(--muted-fg);display:flex}
.row-star{display:flex}
.star-on{color:#f0b429}
.star-off{color:var(--muted-fg)}
.sender{width:176px;flex:0 0 176px;display:flex;align-items:baseline;gap:4px;font-size:14px;
  color:var(--muted-fg);overflow:hidden}
.sender.unread{color:var(--foreground);font-weight:600}
.sender-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sender-count{font-size:12px;font-weight:400;color:var(--muted-fg);flex:0 0 auto}
.subject-wrap{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;overflow:hidden;white-space:nowrap}
.subject{font-size:14px;color:var(--foreground);overflow:hidden;text-overflow:ellipsis;flex:0 1 auto}
.subject.unread{font-weight:600}
.dash{font-size:14px;color:var(--muted-fg);flex:0 0 auto}
.preview{font-size:14px;color:var(--muted-fg);overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
.meta{flex:0 0 auto;display:flex;align-items:center;gap:8px;justify-content:flex-end}
.tag{display:flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:500}
.tag-blue{background:#dbeafe;color:#2563eb}
.tag-green{background:#dcfce7;color:#15803d}
.tag-amber{background:#fef3c7;color:#b45309}
.attach{color:var(--muted-fg)}
.time{font-size:12px;color:var(--muted-fg);text-align:right;min-width:52px;font-variant-numeric:tabular-nums}
</style></head>
<body>
  <div class="rail">
    <div class="rail-logo"><img src="${sarvLogo}" alt=""></div>
    <div class="rail-items">
      ${railItem('mail', true)}
      ${railItem('contact')}
    </div>
    <div class="rail-bottom">
      ${railItem('puzzle')}
      ${railItem('bot')}
      ${railItem('wand-2')}
      ${railItem('settings')}
      ${railItem('shield-check')}
      ${railItem('chevron-right')}
    </div>
  </div>

  <div class="sidebar">
    <div class="sb-head">
      <img class="mark" src="${logoMark}" alt="">
      <img class="word" src="${wordmark}" alt="SarvInbox">
    </div>
    <div class="acct">
      <span class="avatar">S</span>
      <span class="acct-mail">sam@example.com</span>
      ${icon('chevron-down', 16, { cls: 'muted' })}
    </div>
    <div class="compose">${icon('plus', 20)}Compose</div>
    <div class="sb-scroll">
      ${navItems.map(navRow).join('')}
      ${sectionLabel('System')}
      ${systemItems.map(navRow).join('')}
      ${sectionLabel('Labels', true)}
      ${labels
        .map((l) => `<div class="label-row"><span class="dot" style="background:${l.color}"></span><span class="label-name">${l.name}</span></div>`)
        .join('')}
      ${sectionLabel('Folders')}
      ${folders.map((f) => navRow({ icon: 'folder', label: f })).join('')}
    </div>
    <div class="quota">
      <div class="quota-top"><span>4.2 GB of 30 GB</span><span>14%</span></div>
      <div class="quota-bar"><div class="quota-fill"></div></div>
    </div>
    <div class="statusbar">
      <span>v1.2.2</span>
      <span class="status-right"><span class="live-dot"></span><span>Live</span>${icon('refresh-cw', 16)}</span>
    </div>
  </div>

  <div class="main">
    <div class="searchbar">
      <div class="search">
        <span class="s-ic">${icon('search', 16)}</span>
        <input placeholder="Search emails..." readonly>
        <span class="f-ic">${icon('sliders-horizontal', 16)}</span>
      </div>
    </div>
    <div class="listhead">
      ${icon('square', 16)}${icon('chevron-down', 14)}${icon('refresh-cw', 16)}
      <span class="right">${icon('layout-grid', 18)}</span>
    </div>
    <div class="chips">${chips.map(chipEl).join('')}</div>
    <div class="list">
      ${sectionHeader('Important and unread', '2')}
      ${important.map(listRow).join('')}
      ${sectionHeader('Starred', '1–9 of 9')}
      ${starred.map(listRow).join('')}
      ${sectionHeader('Everything else', '1–25 of 2,418')}
      ${everything.map(listRow).join('')}
    </div>
  </div>
</body></html>`;

const out = process.argv[2];
writeFileSync(out, html);
console.log(`wrote ${out} (${html.length} bytes)`);
