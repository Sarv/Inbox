/**
 * The process extensions actually run in.
 *
 * One `utilityProcess` shared by every installed extension. It is deliberately
 * bare: no database handle, no credential store, no window, no filesystem path
 * beyond the extension's own folder. Everything an extension is allowed to do
 * it has to ask main for, over the one message port below, and main answers
 * only what the user granted at install time.
 *
 * Nothing here is app-specific — the engine lives in `@sarvinbox/core` so the
 * tests can drive the identical code over an in-memory channel. This file is
 * only the Electron transport plus the crash handling a real process needs.
 */

import { startExtensionSandbox, type ExtensionChannel } from '@sarvinbox/core';

/**
 * `process.parentPort` exists only inside a `utilityProcess` child, so it is
 * absent from the ambient `process` type.
 */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  once(event: 'close', listener: () => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

if (!parentPort) {
  // Running this file outside a utilityProcess is a build or packaging mistake,
  // not a runtime condition worth recovering from.
  throw new Error('extension-sandbox.worker must be started with utilityProcess.fork');
}

const port = parentPort;

const channel: ExtensionChannel = {
  post: (message) => port.postMessage(message),
  onMessage: (handler) => port.on('message', (event) => handler(event.data)),
  onClose: (handler) => port.once('close', handler),
  // Reached once every extension has been deactivated, which is this process's
  // whole job done. Exiting here is what makes a graceful shutdown graceful:
  // main's kill timer is only the backstop for an extension whose `deactivate()`
  // never returns.
  close: () => process.exit(0),
};

const sandbox = startExtensionSandbox(channel);

/**
 * Report a crash instead of dying from it.
 *
 * An uncaught throw from inside an extension's own callback would otherwise
 * take down every other extension with it. Continuing is safe here precisely
 * because this process holds nothing durable: all state that matters lives in
 * main, and this process can be replaced at any moment. The line goes to the
 * app log through main, tagged with the process, so a crashing extension is
 * still visible rather than silently swallowed.
 */
function report(kind: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  port.postMessage({
    type: 'log',
    extensionId: `sandbox:${kind}`,
    level: 'error',
    message,
  });
}

process.on('uncaughtException', (error) => report('uncaughtException', error));
process.on('unhandledRejection', (reason) => report('unhandledRejection', reason));

// Main closing the port is the shutdown signal; deactivate everything so each
// extension's own `deactivate()` still runs before the process goes away.
process.on('exit', () => {
  void sandbox.dispose();
});
