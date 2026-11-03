/**
 * Mark a file the app wrote from mail as "downloaded from the internet"
 * (CASA 5.2.1 hardening).
 *
 * A browser download carries an OS marker that makes the OS warn before the
 * file runs or opens: Gatekeeper on macOS, SmartScreen / Attachment Manager and
 * Office Protected View on Windows. An attachment this app saves or hands to
 * another app is exactly as untrusted as a download, but a plain write leaves
 * no marker, so without this the OS treats it as a file the user made.
 *
 * Best effort by design: marking never throws and never meaningfully delays a
 * save (bounded by MARK_TIMEOUT_MS). A failure — FAT/exFAT or a network share
 * with no alternate streams, a missing `xattr` — is one warning line carrying
 * the platform and an error CODE only. Node's error MESSAGES embed the path, and
 * the path is the attachment's name, which is mail data.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';

import { createLogger, isTimeoutError, withTimeout } from '@sarvinbox/core';

const logger = createLogger('mark-downloaded');

/**
 * Windows Mark-of-the-Web, written to the `Zone.Identifier` alternate data
 * stream. ZoneId=3 is URLZONE_INTERNET. The format is an INI file and Windows
 * reads it with CRLF line endings — this is the one place `\r\n` is required.
 * No ReferrerUrl/HostUrl: the only "URL" this app has is the message's, and the
 * stream travels with the file wherever the user copies it.
 */
export const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n';

/** Agent name recorded in the macOS quarantine value (no `;`, which is the separator). */
export const QUARANTINE_AGENT = 'Sarv Inbox';

/**
 * macOS quarantine flags, hex. The value is `flags;hex-seconds;agent;uuid`.
 * Bits, from WebKit's QuarantineSPI.h (the public copy of Apple's private
 * quarantine.h): 0x0001 QTN_FLAG_DOWNLOAD (the file came from the network, so
 * Gatekeeper assesses it on first open), 0x0002 QTN_FLAG_SANDBOX (which WebKit
 * adds to its own downloads so a sandboxed process cannot strip the flag), and
 * 0x0040 QTN_FLAG_USER_APPROVED, deliberately CLEAR so that first open is
 * gated. 0x0080 is undocumented but set on every browser download; Eclectic
 * Light's quarantine write-ups give `0083;…;Safari.app;…` as the internet
 * download value. The UUID is left empty: it keys a QuarantineEvents database
 * row that only LaunchServices writes, and the field is optional.
 */
export const QUARANTINE_FLAGS = '0083';

/** The absolute path, so a `xattr` earlier on PATH can never be run instead. */
export const XATTR_PATH = '/usr/bin/xattr';

/** Upper bound on how long a save waits for the mark. */
export const MARK_TIMEOUT_MS = 2_000;

export function quarantineValue(nowMs: number): string {
  return `${QUARANTINE_FLAGS};${Math.floor(nowMs / 1000).toString(16)};${QUARANTINE_AGENT};`;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number; shell: false; windowsHide: true },
  callback: (error: Error | null) => void,
) => unknown;

export interface MarkDownloadedDependencies {
  platform?: NodeJS.Platform;
  writeFile?: (filePath: string, content: string) => Promise<void>;
  execFile?: ExecFileFn;
  now?: () => number;
  timeoutMs?: number;
}

function runXattr(run: ExecFileFn, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // execFile, never exec: no shell parses the attachment's name.
    run(XATTR_PATH, args, { timeout, shell: false, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
  });
}

function failureCode(error: unknown): string {
  if (isTimeoutError(error)) return 'timeout';
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : 'error';
}

/**
 * Mark `filePath` as downloaded from the internet. Resolves in every case.
 * Linux: there is no standard. freedesktop's `user.xdg.origin.url` xattr is
 * informational only (no desktop gates opening on it), Node has no xattr API,
 * and `setfattr` is not installed by default — so this is a documented no-op.
 */
export async function markDownloadedFromInternet(
  filePath: string,
  deps: MarkDownloadedDependencies = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const timeoutMs = deps.timeoutMs ?? MARK_TIMEOUT_MS;
  let mark: Promise<void>;
  try {
    if (platform === 'win32') {
      const write = deps.writeFile ?? ((target: string, content: string) => fs.writeFile(target, content));
      // `file:stream` names an NTFS alternate data stream of the same file — a
      // stream suffix, not a path segment, so it is appended, not path.join'ed.
      mark = write(`${filePath}:Zone.Identifier`, ZONE_IDENTIFIER);
    } else if (platform === 'darwin') {
      const value = quarantineValue((deps.now ?? Date.now)());
      mark = runXattr(deps.execFile ?? execFile, ['-w', 'com.apple.quarantine', value, filePath], timeoutMs);
    } else {
      return;
    }
    await withTimeout(mark, timeoutMs, 'Marking the saved file timed out');
  } catch (error) {
    logger.warn(`Could not mark a saved attachment as downloaded from the internet (${platform}, ${failureCode(error)}); the OS will not warn when it is opened`);
  }
}
