#!/usr/bin/env node
/*
 * The release workflow's view of Windows code signing.
 *
 *   node scripts/windows-signing.mjs status [--previous-release <owner/repo>] [--github-output]
 *     Validate apps/desktop/build/windows-signing.json and say whether signing
 *     is on (it is iff the certificate chain is committed). With
 *     --previous-release, first ask GitHub (gh api, GH_TOKEN) what the release
 *     marked Latest pins, log it, and exit 1 if installs updated by it would
 *     refuse this build (unsigned, or signed under a CN it does not list). With
 *     --github-output, writes enabled / publisher (the certificate CN) /
 *     publisher_names (the whole pinned list, as JSON) / provider /
 *     service_account to $GITHUB_OUTPUT. Exits 1 when signing is enabled but
 *     misconfigured, or when publisherNames is set but the chain is missing --
 *     the Windows build must not go on unsigned.
 *
 *   node scripts/windows-signing.mjs fetch-jsign --dest <dir> [--github-output]
 *     Download the pinned jsign jar and refuse it unless its sha256 matches
 *     the committed digest. With --github-output, writes `path`.
 *
 * See scripts/lib/windows-signing.mjs and docs/WINDOWS_SIGNING.md.
 */

import { windowsSigningCli } from './lib/windows-signing.mjs';

windowsSigningCli(process.argv.slice(2)).then((code) => process.exit(code));
