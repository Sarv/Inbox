#!/usr/bin/env node
/*
 * Fail the Windows release build unless its Authenticode signatures are what
 * an installed copy will demand of the next update. Windows only: it asks
 * Get-AuthenticodeSignature, the same API electron-updater uses.
 *
 * Usage:
 *   node scripts/verify-win-signatures.mjs apps/desktop/release
 *
 * Signing enabled (the certificate chain is committed): every PE file in
 * win-unpacked and win-arm64-unpacked plus the installer must be Valid and
 * timestamped; the two app executables, the .node addons and the installer
 * must be signed by a publisher (a CN in publisherNames); any other PE file
 * (DLLs, elevate.exe, helpers) may instead keep a signature it arrived with
 * (logged); and resources/app-update.yml in both apps must pin exactly
 * publisherNames.
 *
 * Signing disabled: app-update.yml must carry NO publisherName (absent, or
 * null) -- an unsigned build that pins anything, even [], would make every
 * install refuse all later unsigned updates -- and the step only warns that
 * the build is unsigned.
 *
 * See scripts/lib/windows-signing.mjs and docs/WINDOWS_SIGNING.md.
 */

import { verifyWinSignaturesCli } from './lib/windows-signing.mjs';

verifyWinSignaturesCli(process.argv.slice(2)).then((code) => process.exit(code));
