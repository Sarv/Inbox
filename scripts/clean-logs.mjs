#!/usr/bin/env node
/*
 * Sarv Inbox — clear debug logs (cross-platform: macOS, Windows, Linux)
 *
 * Deletes app.log AND its rotated siblings (app.log.1, …) from every known
 * userData path. Logs-only — does NOT touch the database, caches, or credentials.
 *
 * The rotation is why this is not a one-liner: the file logger renames app.log →
 * app.log.1 at its size cap, so deleting only app.log leaves the older — usually
 * larger — half behind. These logs carry mail addresses, subjects and folder
 * names, and this script is what people run before attaching a log to a bug
 * report, so a half-clean is a privacy problem, not just wasted disk.
 *
 * Tip: quit the app first; a running instance keeps its own file handle and will
 * recreate app.log on the next write.
 *
 * Run: `node scripts/clean-logs.mjs`
 */

import path from 'node:path';

import {
  getAppDataDirs,
  fileSize,
  humanSize,
  listLogFiles,
  lockedPaths,
  rmFile,
} from './lib/userdata-dirs.mjs';

console.log('Sarv Inbox — clear debug logs');
console.log('=============================');

let removed = 0;
let freed = 0;
for (const { label, dir } of getAppDataDirs()) {
  for (const logPath of listLogFiles(dir)) {
    const size = fileSize(logPath);
    if (!rmFile(logPath)) continue;
    console.log(`  Deleted: ${label}/${path.basename(logPath)} (${humanSize(size)})`);
    removed += 1;
    freed += size;
  }
}

if (removed === 0) {
  console.log('  No log files found.');
} else {
  console.log(`  ${removed} file(s), ${humanSize(freed)} freed.`);
}

if (lockedPaths.length > 0) {
  console.log(`\n⚠  ${lockedPaths.length} log file(s) are still in use and were kept:`);
  for (const p of lockedPaths) console.log(`     ${p}`);
  console.log('   Quit Sarv Inbox and run this again.');
  process.exitCode = 1;
}

console.log('Done.');
