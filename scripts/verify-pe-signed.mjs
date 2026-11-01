#!/usr/bin/env node
/*
 * The publish job's last look at the Windows installer before its hash goes
 * into the signed update manifest: when Windows signing is enabled, every file
 * given must be a PE binary carrying a well-formed Authenticode certificate
 * table. Runs on any OS (the publish job is Linux), so it cannot judge whether
 * the signature is VALID -- the build job did that on Windows -- but it stops
 * an unsigned installer from being published as the update every signed
 * install would then reject.
 *
 * Usage:
 *   node scripts/verify-pe-signed.mjs artifacts/*.exe
 *
 * When signing is disabled it only warns.
 */

import { verifyPeSignedCli } from './lib/windows-signing.mjs';

verifyPeSignedCli(process.argv.slice(2)).then((code) => process.exit(code));
