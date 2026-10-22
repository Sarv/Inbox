#!/usr/bin/env node
/* Cache cleanup preserves mail, local drafts, outbox and credentials.
 * --full explicitly removes a whole selected profile. The CLI defaults to dev.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cleanProfileCaches, eraseProfiles, getResetProfiles, planProfileCleanup } from './lib/profile-reset.mjs';

const USAGE = `Usage: node scripts/clean-db.mjs [--profile development|production|all] [--full] [--dry-run] [-y|--yes]

  Default              development profile; cache + rotated logs only
  --profile production installed app profile (must be selected explicitly)
  --profile all        both current profiles (must be selected explicitly)
  --full               delete the entire selected profile, including accounts,
                       local mail, drafts, outbox, calendar, chats and saved keys
  --dry-run            show planned paths without changing anything
  -y, --yes            cache cleanup; never implies --full

Quit the selected app first. A reset does not change system Keychain entries,
your external browser's sign-in cookies or server-side email. Reinstalling the
app alone preserves its profile. Older legacy profiles are not selected.`;

export function parseCleanupArgs(argv) {
  let profile = 'development'; let seenProfile = false; let full = false; let dryRun = false; let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') {
      if (seenProfile) throw new Error('Specify --profile only once.');
      profile = argv[++index]; seenProfile = true;
      if (!['development', 'production', 'all'].includes(profile)) throw new Error('Invalid profile. Choose development, production or all.');
    } else if (arg === '--full') full = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '-y' || arg === '--yes') { /* Safe cleanup is already the default. */ }
    else if (arg === '-h' || arg === '--help') help = true;
    else throw new Error(`Unknown argument: ${String(arg)}`);
  }
  return { profiles: profile === 'all' ? ['production', 'development'] : [profile], full, dryRun, help };
}

/** Dependency injection is main/test-only; real CLI accepts no arbitrary path. */
export function runCleanupCli(argv, options = {}) {
  const cli = parseCleanupArgs(argv); const log = options.log || console.log;
  if (cli.help) { log(USAGE); return; }
  const profiles = getResetProfiles(options).filter(item => cli.profiles.includes(item.id));
  log(`Sarv Inbox ${cli.full ? 'full profile reset' : 'cache and log cleanup'}${cli.dryRun ? ' — dry run' : ''}`);
  for (const profile of profiles) {
    log(`${profile.label}: ${profile.dir}${profile.exists ? '' : ' (not found)'}`);
    if (profile.blockedReason) log(`  Blocked: ${profile.blockedReason}`);
    for (const file of planProfileCleanup({ profile: profile.id, baseDir: options.baseDir, full: cli.full })) log(`  ${cli.full ? 'Delete profile' : 'Clear cache/log'}: ${file}`);
  }
  if (cli.dryRun) { log('Dry run complete. No files or locks were changed.'); return; }
  const blocked = profiles.find(profile => profile.running);
  if (blocked) throw new Error(blocked.blockedReason);
  if (cli.full) {
    const results = eraseProfiles({ ...options, profiles: cli.profiles });
    for (const result of results) log(`${result.profile}: ${result.removed ? 'profile removed and absence verified' : 'profile already absent'}.`);
    log('Full reset complete. Redo onboarding on next launch. External browser sign-ins and system Keychain entries were preserved.');
  } else {
    const results = cleanProfileCaches({ ...options, profiles: cli.profiles });
    for (const result of results) log(`${result.profile}: ${result.removed.length} cache/log item(s) removed.`);
    log('Cleanup complete. Mail databases, drafts, outbox, accounts, credentials, calendar, chats and attachments were preserved.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runCleanupCli(process.argv.slice(2)); }
  catch (error) { console.error(`Cleanup failed: ${error instanceof Error ? error.message : 'The profile could not be checked safely.'}`); process.exitCode = 1; }
}
