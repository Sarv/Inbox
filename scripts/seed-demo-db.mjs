#!/usr/bin/env node
/**
 * Seed a clean DEMO SQLite DB for README screenshots / walkthrough video.
 *
 * The desktop app is local-first: the inbox renders straight from
 * `sarvinbox.db` in the app's userData dir (`~/Library/Application Support/
 * Sarv Inbox` on macOS, `%APPDATA%\Sarv Inbox` on Windows, `~/.config/Sarv
 * Inbox` on Linux) with NO IMAP connection needed. This script fills that DB
 * with synthetic `@sarv.com` mail so the UI looks realistic offline.
 *
 * Safety:
 *   • Any existing sarvinbox.db (+ -wal/-shm) is MOVED to a timestamped
 *     backup folder, never deleted. Restore instructions are printed at the end.
 *   • Uses an unroutable IMAP host in the fake creds you set in the renderer,
 *     so the app never connects and never reconciles/purges the seeded rows.
 *
 * Usage (run via the wrapper — it sets the Electron ABI env for you):
 *   1. QUIT the desktop app fully (so it isn't holding the DB / WAL).
 *   2. sh scripts/seed-demo.sh
 *   3. Launch: sh scripts/dev.sh   (see printed DevTools snippet to unlock the UI)
 *   4. To restore your real inbox: quit the app and run the printed restore cmd.
 */
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { appDataBase } from './lib/userdata-dirs.mjs';

// Import the built storage facade — it runs migrations (adds priority_score +
// FTS) and insertEmail() auto-creates the thread row we'd otherwise FK-fail on.
// Use the CJS build: a migration reads schema.sql via __dirname, which is only
// defined in CJS (the .mjs build leaves __dirname undefined and crashes).
// Run this under Electron-as-Node so better-sqlite3's Electron-ABI binary loads:
//   ELECTRON_RUN_AS_NODE=1 <electron> scripts/seed-demo-db.mjs
const require = createRequire(import.meta.url);
const { SQLiteStorage } = require('../packages/storage-node/dist/index.js');

// SARVINBOX_DB overrides the target DB (used for safe testing); by default we
// seed the real app DB the desktop client reads on launch, under the platform's
// userData dir (macOS / Windows / Linux — see scripts/lib/userdata-dirs.mjs).
const DB_PATH = process.env.SARVINBOX_DB || join(appDataBase(), 'Sarv Inbox', 'sarvinbox.db');
const APP_DIR = dirname(DB_PATH);
const INBOX_ID = 'demo-inbox';

// ── Back up any existing DB (move, never delete) ─────────────────────────
mkdirSync(APP_DIR, { recursive: true });
if (existsSync(DB_PATH)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(APP_DIR, `backup-${stamp}`);
  mkdirSync(backupDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${DB_PATH}${suffix}`;
    if (existsSync(src)) renameSync(src, join(backupDir, `sarvinbox.db${suffix}`));
  }
  console.log(`✓ Backed up existing DB → ${backupDir}`);
  console.log(`  Restore later with:`);
  console.log(`    rm -f "${DB_PATH}"* && mv "${backupDir}/"* "${APP_DIR}/"\n`);
}

// ── Synthetic content ────────────────────────────────────────────────────
const HOUR = 3600;
const NOW = Math.floor(Date.now() / 1000);
const tags = (...names) => `|INBOX|${names.length ? names.join('|') + '|' : ''}`;
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

// Each entry becomes one email row. `thread` groups messages into a conversation.
// Omit 'read' to render as unread (bold). Category tags (needs_response, meeting,
// finance, promotions) surface as badges; important/starred drive the sections.
const DATA = [
  { from: ['Pooja Khatri', 'pkh@sarv.com'], subject: 'Q3 roadmap review — need your sign-off', tags: ['important', 'needs_response'], ageH: 1, body: 'Hi — attaching the Q3 roadmap. Can you sign off on the priorities before Friday? A few items need your call.', attach: true },
  { from: ['Sneha Dias', 'sneha.dias@sarv.com'], subject: 'Re: Content policy implementation', tags: ['important', 'read'], ageH: 3, thread: 'th-policy', body: 'Thanks for the draft. I left comments on sections 2 and 4 — mostly wording.' },
  { from: ['Advik Dutta', 'advik.d@sarv.com'], subject: 'Re: Content policy implementation', tags: ['read'], ageH: 2, thread: 'th-policy', body: 'Addressed your comments and pushed the update. Take another look when you can.' },
  { from: ['Calendar', 'calendar@sarv.com'], subject: 'Canceled event: Madhav Sethi 1:1', tags: ['meeting'], ageH: 5, body: 'This event has been canceled: Madhav Sethi 1:1, Thursday 3:00 PM.' },
  { from: ['Kriti Joshi', 'kriti.j@sarv.com'], subject: 'Design sync notes + next steps', tags: ['starred', 'read', 'meeting'], ageH: 7, body: 'Notes from today\'s design sync are in the doc. Next steps assigned — see the table at the bottom.' },
  { from: ['Billing', 'billing@sarv.com'], subject: 'Invoice #INV-2043 is ready', tags: ['finance'], ageH: 9, body: 'Your invoice INV-2043 for ₹7,499 is ready. Payment is due in 14 days.', attach: true },
  { from: ['Sohum Jadeja', 'sohum.j@sarv.com'], subject: 'Can you review my PR today?', tags: ['needs_response'], ageH: 11, body: 'Pushed the sync-pipeline refactor. It\'s not huge — would love a review before EOD so I can merge.' },
  { from: ['Coursera', 'no-reply@sarv.com'], subject: 'Final days: ₹7,499/year for unlimited learning', tags: ['promotions', 'read'], ageH: 26, body: 'Last chance — get unlimited access to 7,000+ courses at our lowest price of the year.' },
  { from: ['Meghna Kotak', 'meghna.k@sarv.com'], subject: 'Welcome to the team!', tags: ['important', 'starred'], ageH: 30, body: 'Really glad to have you on board. Here\'s everything you need for your first week.' },
  { from: ['HR', 'hr@sarv.com'], subject: 'Reminder: submit your timesheet', tags: ['read'], ageH: 34, body: 'Friendly reminder to submit your timesheet for this week before the cutoff on Sunday.' },
  { from: ['Product Updates', 'product@sarv.com'], subject: 'What\'s new in Sarv Inbox 1.1', tags: ['read'], ageH: 50, body: 'Section-based inbox, AI conversation view, and faster search. Here\'s a tour of the highlights.' },
  { from: ['Hrishi', 'hrishi@sarv.com'], subject: 'Lunch next week?', tags: ['read'], ageH: 74, body: 'Been a while! Free for lunch sometime next week? Tuesday or Thursday works for me.' },
  { from: ['Security', 'security@sarv.com'], subject: 'New sign-in to your account', tags: ['important', 'read'], ageH: 100, body: 'We noticed a new sign-in from a Mac in Jaipur. If this was you, no action is needed.' },
  { from: ['Newsletter', 'news@sarv.com'], subject: 'The weekly digest: 5 reads for your weekend', tags: ['promotions', 'read'], ageH: 120, body: 'Your curated weekend reading list is here — five stories worth your time.' },
];

// ── Seed ─────────────────────────────────────────────────────────────────
// readonly/verbose must be booleans — better-sqlite3 rejects a present-but-
// undefined option key.
const storage = new SQLiteStorage({ dbPath: DB_PATH, readonly: false, verbose: false });
await storage.initialize();

const total = DATA.length;
const unread = DATA.filter((e) => !e.tags.includes('read')).length;

await storage.syncFolders([
  {
    id: INBOX_ID, name: 'INBOX', path: 'INBOX', parentId: null,
    uidValidity: 1, lastSyncUid: total, lastSyncTime: NOW,
    totalCount: total, unreadCount: unread, specialUse: '\\Inbox',
    subscribed: true, createdAt: NOW, updatedAt: NOW,
  },
]);

let uid = 1000;
for (const e of DATA) {
  const [fromName, fromAddress] = e.from;
  const date = NOW - e.ageH * HOUR;
  const messageId = `<demo-${uid}@sarv.com>`;
  const threadId = e.thread || `th-${uid}`;
  const record = {
    id: `demo-${uid}`,
    messageId,
    threadId,
    folderId: INBOX_ID,
    uid: uid++,
    tags: tags(...e.tags),
    subject: e.subject,
    fromAddress,
    fromName,
    toAddress: 'advik.d@sarv.com',
    toNames: 'Advik Dutta',
    ccAddress: null, ccNames: null, bccAddress: null, bccNames: null, replyTo: null,
    date,
    receivedDate: date,
    cleanBody: e.body,
    rawBody: `<p>${e.body}</p>`,
    contentType: 'html',
    contentHash: hash(messageId + e.body),
    inReplyTo: null,
    references: null,
    priority: e.tags.includes('important') ? 'high' : 'normal',
    hasAttachments: !!e.attach,
    attachmentCount: e.attach ? 1 : 0,
    attachmentNames: e.attach ? 'document.pdf' : null,
    importanceScore: e.tags.includes('important') ? 90 : 0,
    importanceSource: e.tags.includes('important') ? 'ai' : 'none',
    hasEmbedding: false,
    createdAt: date,
    updatedAt: date,
  };
  await storage.insertEmail(record);
}

await storage.close();

console.log(`✓ Seeded ${total} emails (${unread} unread) into ${DB_PATH}`);
console.log('\nNext:');
console.log('  1. sh scripts/dev.sh   (launch the desktop app)');
console.log('  2. In the app, open DevTools (Cmd+Opt+I) → Console, paste:');
console.log(`     localStorage.setItem('sarvinbox-onboarding-complete','true');`);
console.log(`     localStorage.setItem('sarvinbox-credentials', JSON.stringify({host:'imap.invalid.local',port:993,secure:true,username:'demo@sarv.com',password:'x',authMethod:'password'}));`);
console.log(`     localStorage.setItem('sarvinbox-settings', JSON.stringify({inboxType:'priority_first'}));`);
console.log(`     location.reload();`);
console.log('  3. The populated inbox renders offline — capture with Cmd-Shift-4 (shots) / Cmd-Shift-5 (video).');
