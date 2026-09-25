/**
 * Forks and supervises the extension sandbox process.
 *
 * Extensions used to run inside main: a `require()` of third-party code in the
 * same process that holds the database key, the credential vault and every
 * open IMAP connection. A crash there took the app down, and a bug there had
 * the app's whole reach. Now they run in a `utilityProcess` that holds none of
 * it, and this module is the seam — it hands `ExtensionHost` a channel and
 * knows nothing about what travels over it.
 */

import { join } from 'path';

import { createLogger, resolveUnpacked, type ExtensionChannel } from '@sarvinbox/core';
import { utilityProcess, type UtilityProcess } from 'electron';

const logger = createLogger('extension-runtime');

/**
 * Where the built sandbox entry lives — emitted beside the main bundle.
 *
 * `utilityProcess.fork` spawns a real file, so this entry MUST also be listed
 * in electron-builder's `asarUnpack` (`apps/desktop/package.json`). Without it
 * the rewrite below points at a file that was never written outside the
 * archive, the child exits with ERR_MODULE_NOT_FOUND, and every extension
 * reads "Extension sandbox is not running" — in packaged builds only.
 */
export function sandboxEntryPath(): string {
  return resolveUnpacked(join(__dirname, 'extension-sandbox.worker.js'));
}

/** How long a closing sandbox gets to run `deactivate()` before it is killed. */
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Start the sandbox process and return the channel to it.
 *
 * The channel is the only thing the caller gets: there is no handle to the
 * process, because nothing above this line should be making decisions about
 * it. A child that exits — crash, OOM, or the kill below — closes the channel,
 * and the host treats that as every extension having stopped.
 */
export function createSandboxChannel(): ExtensionChannel {
  const entry = sandboxEntryPath();
  logger.info(`Starting extension sandbox: ${entry}`);

  const child: UtilityProcess = utilityProcess.fork(entry, [], {
    serviceName: 'SarvInboxExtensions',
    // Piped rather than inherited so a stray write from extension code lands in
    // the app log through the handlers below, structured and attributed,
    // instead of straight onto the terminal.
    stdio: 'pipe',
  });

  const closeHandlers: (() => void)[] = [];
  let exited = false;

  const notifyClosed = (): void => {
    if (exited) return;
    exited = true;
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch (error) {
        logger.warn('Extension sandbox close handler failed:', error);
      }
    }
  };

  child.on('exit', (code) => {
    logger.warn(`Extension sandbox exited with code ${code}`);
    notifyClosed();
  });

  child.stdout?.on('data', (chunk: Buffer) => logger.info(`[sandbox] ${chunk.toString().trimEnd()}`));
  child.stderr?.on('data', (chunk: Buffer) => logger.warn(`[sandbox] ${chunk.toString().trimEnd()}`));

  return {
    post: (message) => {
      if (exited) return;
      child.postMessage(message);
    },
    onMessage: (handler) => {
      child.on('message', (message) => handler(message));
    },
    onClose: (handler) => {
      if (exited) {
        handler();
        return;
      }
      closeHandlers.push(handler);
    },
    close: () => {
      if (exited) return;
      // The host has already asked the sandbox to wind down, and the sandbox
      // exits itself once every `deactivate()` has returned. This is only the
      // backstop: a hook that hangs must not be able to hold up quitting.
      const timer = setTimeout(() => {
        logger.warn('Extension sandbox did not exit in time; terminating');
        child.kill();
      }, SHUTDOWN_GRACE_MS);
      // Unreferenced so this timer alone never keeps the app alive.
      timer.unref?.();
      child.once('exit', () => clearTimeout(timer));
    },
  };
}
