#!/usr/bin/env node
/*
 * Sarv Inbox Cleanup Script (cross-platform: macOS, Windows, Linux)
 *
 * Deletes the local mailbox database, caches, browser data, and stale .js files
 * across every userData path the app has ever used (present + legacy).
 *
 * Optional full reset (asks first, default = No) also deletes the core DB, its
 * encryption key, and the credential/config files — the true "start over".
 *
 * Node-only, no shell dependency, so `pnpm clean:db` behaves identically on all
 * three OSes.
 *
 *   node scripts/clean-db.mjs          prompt; default = safe clean
 *   node scripts/clean-db.mjs -y       no prompt, safe clean (keeps credentials)
 *   node scripts/clean-db.mjs --full   no prompt, FULL reset (wipes credentials)
 *
 * QUIT THE APP FIRST. A running instance holds these files open: Windows then
 * refuses the delete, and macOS/Linux unlink them while the app keeps writing to
 * the orphaned inode. Anything still locked is reported at the end.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { cleanStaleJs } from './lib/stale-js.mjs';
import {
  getAppDataDirs,
  exists,
  fileSize,
  humanSize,
  listLogFiles,
  lockedPaths,
  rmFile,
  rmDir,
} from './lib/userdata-dirs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DESKTOP_DIR = path.join(PROJECT_ROOT, 'apps', 'desktop');
// Both trees tsc can leave output in — the same pair the desktop package's own
// `clean` script sweeps, so the two cannot disagree about what "stale" means.
const STALE_JS_DIRS = [path.join(DESKTOP_DIR, 'electron'), path.join(DESKTOP_DIR, 'src')];

// The durable, encrypted store: accounts registry, OAuth tokens, IMAP config,
// and profile were all migrated OUT of localStorage / the standalone JSON files
// INTO this core DB (see core-db.ts / imap-account-store.ts). db-key.bin is the
// SQLCipher key that unlocks it AND every per-account DB — deleting it makes all
// databases unreadable, so it counts as a credential (full reset only).
const CORE_DB = 'sarvinbox-core.db';

const APP_DATA_DIRS = getAppDataDirs();

// Browser-engine data Electron/Chromium writes — always safe to delete (caches,
// sessions, cookies). Local Storage / Preferences are handled separately.
const BROWSER_DIRS_ALWAYS = [
  'Session Storage',
  'IndexedDB',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'blob_storage',
  'File System',
  'Service Worker',
  'WebStorage',
  'Shared Dictionary',
];
const BROWSER_FILES_ALWAYS = [
  'Cookies',
  'Cookies-journal',
  'Network Persistent State',
  'SharedStorage',
  'SharedStorage-wal',
  'TransportSecurity',
  'Trust Tokens',
  'Trust Tokens-journal',
];

function cleanAppData({ label, dir }, deleteCreds) {
  console.log(`── ${label} ──`);
  console.log(`   Path: ${dir}`);

  if (!exists(dir)) {
    console.log('   Not found, skipping.\n');
    return;
  }

  // Mailbox databases: per-account "sarvinbox-<id>.db" plus the legacy single-DB
  // names ("sarvinbox.db", older "emailgpt.db"). These hold re-syncable IMAP
  // mail — deleting them forces a fresh sync but keeps accounts/credentials
  // (those live in the core DB, handled below). The core DB is explicitly
  // skipped here so a default clean never wipes credentials.
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    entries = [];
  }
  const isMailboxDb = (name) =>
    name !== CORE_DB &&
    (name === 'sarvinbox.db' ||
      name === 'emailgpt.db' ||
      (name.startsWith('sarvinbox-') && name.endsWith('.db')));

  let dbDeleted = 0;
  for (const name of entries.filter(isMailboxDb)) {
    const dbPath = path.join(dir, name);
    const size = fileSize(dbPath);
    rmFile(dbPath);
    // SQLite sidecars, plus the .bak a compaction/migration can leave behind —
    // that copy holds the same mail, so deleting the DB without it is not a
    // clean at all.
    rmFile(`${dbPath}-shm`);
    rmFile(`${dbPath}-wal`);
    rmFile(`${dbPath}.bak`);
    console.log(`   Database: deleted ${name} (${humanSize(size)})`);
    dbDeleted += 1;
  }
  if (dbDeleted === 0) console.log('   Database: not found');

  // Debug logs — app.log AND its rotated siblings (app.log.1, …). See
  // listLogFiles: the rotation means "delete app.log" leaves the older half.
  const logs = listLogFiles(dir);
  if (logs.length > 0) {
    const total = logs.reduce((sum, p) => sum + fileSize(p), 0);
    for (const p of logs) rmFile(p);
    const names = logs.map((p) => path.basename(p)).join(', ');
    console.log(`   Debug logs: deleted ${logs.length} file(s) — ${names} (${humanSize(total)})`);
  }

  // Attachment cache
  if (exists(path.join(dir, 'attachment-cache'))) {
    rmDir(path.join(dir, 'attachment-cache'));
    console.log('   Attachment cache: deleted');
  }

  // Extensions data
  if (rmDir(path.join(dir, 'extensions-data'))) {
    console.log('   Extensions data: deleted');
  }

  // Core DB + credentials. The core DB (accounts, OAuth tokens, IMAP config,
  // profile), its db-key.bin, and the legacy standalone JSON stores are all
  // credentials — keep by default, delete only on a full reset. Deleting
  // db-key.bin alone would orphan every DB, so it's always paired with the
  // core DB here.
  if (deleteCreds) {
    const credFiles = [
      CORE_DB,
      `${CORE_DB}-shm`,
      `${CORE_DB}-wal`,
      `${CORE_DB}.bak`,
      'db-key.bin',
      'oauth-accounts.json',
      'oauth-accounts.json.bak',
      'imap-account.json',
      'agent-config.json',
      'pipeline-ai-config.json',
    ];
    let credDeleted = 0;
    for (const name of credFiles) {
      if (rmFile(path.join(dir, name))) {
        console.log(`   Deleted ${name}`);
        credDeleted += 1;
      }
    }
    console.log(`   Core DB + credentials: DELETED (${credDeleted} files — accounts, tokens, keys)`);
  } else {
    console.log('   Core DB + credentials: kept (sarvinbox-core.db, db-key.bin, config)');
  }

  // Browser data (caches, sessions, cookies) — always safe to remove.
  let cleaned = 0;
  for (const d of BROWSER_DIRS_ALWAYS) {
    if (rmDir(path.join(dir, d))) cleaned += 1;
  }
  for (const f of BROWSER_FILES_ALWAYS) {
    if (rmFile(path.join(dir, f))) cleaned += 1;
  }

  // Local Storage / Preferences: legacy UI settings and any not-yet-migrated
  // renderer state. The source of truth for credentials/accounts is the core DB
  // (handled above), so this only matters on a full reset.
  if (deleteCreds) {
    if (rmDir(path.join(dir, 'Local Storage'))) cleaned += 1;
    if (rmFile(path.join(dir, 'Preferences'))) cleaned += 1;
    console.log('   Local Storage + Preferences: deleted (legacy UI state — full reset)');
    console.log('   ⚠  You will need to redo onboarding (profile, IMAP, AI provider)');
  } else {
    console.log('   Local Storage + Preferences: kept');
  }

  if (cleaned > 0) {
    console.log(`   Browser data: cleaned ${cleaned} items (caches, cookies, sessions)`);
  }

  console.log('');
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node scripts/clean-db.mjs [--full] [-y|--yes]\n');
    console.log('  (no flags)   prompt, defaulting to the safe clean');
    console.log('  -y, --yes    skip the prompt and take that safe default');
    console.log('  --full       FULL reset: also deletes accounts, OAuth tokens and db-key.bin');
    console.log('\nQuit the app first — a running instance holds these files open.');
    return;
  }

  // --full is the ONLY way to delete credentials. `-y` used to mean it too,
  // which inverted the universal convention that -y answers the prompt with its
  // DEFAULT — and the default here is the safe clean. Anyone scripting
  // `pnpm clean:db -y` for an unattended safe clean was silently wiping their
  // OAuth tokens and db-key.bin instead.
  const forceFull = argv.includes('--full');
  const assumeDefault = argv.includes('-y') || argv.includes('--yes');

  console.log('Sarv Inbox Cleanup');
  console.log('==================\n');

  let deleteCreds;
  if (forceFull) {
    deleteCreds = true;
    console.log('Full reset requested via --full — deleting credentials + profile too.\n');
  } else if (assumeDefault) {
    deleteCreds = false;
    console.log('-y — taking the default: safe clean, credentials kept (use --full to wipe them).\n');
  } else if (!process.stdin.isTTY) {
    // Non-interactive (CI, piped): choose the safe default, never wipe credentials.
    deleteCreds = false;
    console.log('Non-interactive shell — defaulting to safe clean (credentials kept).\n');
  } else {
    console.log('Delete IMAP credentials, AI API keys, accounts, and profile?');
    console.log('  N (default) = Keep credentials + accounts. Only delete mailbox DB and caches.');
    console.log('  Y = Full reset. Deletes everything including accounts, keys, and profile.');
    const answer = (await ask('Full reset? [y/N]: ')).trim().toLowerCase();
    deleteCreds = answer === 'y' || answer === 'yes';
    console.log('');
  }

  for (const appData of APP_DATA_DIRS) {
    cleanAppData(appData, deleteCreds);
  }

  console.log('── Stale .js files ──');
  const { removed } = cleanStaleJs(STALE_JS_DIRS);
  if (removed.length > 0) {
    console.log(`   Removed ${removed.length} stale .js files (had matching .ts sources)\n`);
  } else {
    console.log('   No stale .js files found.\n');
  }

  if (deleteCreds) {
    console.log('Done. Full reset — mailbox, core DB, credentials, profile all deleted.');
    console.log("You'll need to redo onboarding on next launch.");
  } else {
    console.log('Done. Mailbox DB + caches deleted. Your accounts, credentials, and profile are preserved.');
    console.log('Restart the app to create a fresh database.');
  }

  // Anything still held open means the clean only half happened. Say so loudly
  // rather than reporting success over a userData dir that is now in a state
  // neither the user nor the app expects.
  if (lockedPaths.length > 0) {
    console.log(`\n⚠  ${lockedPaths.length} item(s) could not be deleted — still in use:`);
    for (const p of lockedPaths) console.log(`     ${p}`);
    console.log('   Quit Sarv Inbox and run this again.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exitCode = 1;
});
