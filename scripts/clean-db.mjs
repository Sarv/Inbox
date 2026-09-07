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
 * three OSes. Run: `node scripts/clean-db.mjs` (add --full / -y for a full reset
 * without the prompt).
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { getAppDataDirs, exists, fileSize, humanSize, rmFile, rmDir } from './lib/userdata-dirs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(PROJECT_ROOT, 'apps', 'desktop', 'electron');

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
    rmFile(`${dbPath}-shm`);
    rmFile(`${dbPath}-wal`);
    console.log(`   Database: deleted ${name} (${humanSize(size)})`);
    dbDeleted += 1;
  }
  if (dbDeleted === 0) console.log('   Database: not found');

  // Debug log
  const logPath = path.join(dir, 'app.log');
  if (exists(logPath)) {
    const size = fileSize(logPath);
    rmFile(logPath);
    console.log(`   Debug log: deleted (${humanSize(size)})`);
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

/** Remove compiled *.js files that have a sibling *.ts source (stale build output). */
function cleanStaleJs(rootDir) {
  let removed = 0;
  const walk = (currentDir) => {
    let dirents = [];
    try {
      dirents = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (dirent.name === 'node_modules' || dirent.name === 'dist') continue;
      const full = path.join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else if (dirent.isFile() && full.endsWith('.js')) {
        const tsFile = `${full.slice(0, -3)}.ts`;
        if (exists(tsFile)) {
          rmFile(full);
          removed += 1;
        }
      }
    }
  };
  if (exists(rootDir)) walk(rootDir);
  return removed;
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
  const forceFull = argv.includes('--full') || argv.includes('-y') || argv.includes('--yes');

  console.log('Sarv Inbox Cleanup');
  console.log('==================\n');

  let deleteCreds;
  if (forceFull) {
    deleteCreds = true;
    console.log('Full reset requested via flag — deleting credentials + profile too.\n');
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
  const jsCount = cleanStaleJs(ELECTRON_DIR);
  if (jsCount > 0) {
    console.log(`   Removed ${jsCount} stale .js files (had matching .ts sources)\n`);
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
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exitCode = 1;
});
