#!/usr/bin/env node
/*
 * Sarv Inbox — clear debug logs (cross-platform: macOS, Windows, Linux)
 *
 * Deletes the local debug log (app.log) from every known userData path.
 * Logs-only — does NOT touch the database, caches, or credentials.
 *
 * Tip: quit the app first; a running instance keeps its own file handle and will
 * recreate app.log on the next write.
 *
 * Run: `node scripts/clean-logs.mjs`
 */

import path from 'node:path';
import { getAppDataDirs, exists, fileSize, humanSize, rmFile } from './lib/userdata-dirs.mjs';

console.log('Sarv Inbox — clear debug logs');
console.log('=============================');

let removed = 0;
for (const { label, dir } of getAppDataDirs()) {
  const logPath = path.join(dir, 'app.log');
  if (!exists(logPath)) continue;
  const size = fileSize(logPath);
  rmFile(logPath);
  console.log(`  Deleted: ${label}/app.log (${humanSize(size)})`);
  removed += 1;
}

if (removed === 0) {
  console.log('  No app.log found.');
}
console.log('Done.');
