/**
 * The whole preload of an extension's sandbox page.
 *
 * Main hands over one message port, and this starts the Worker and gives it the
 * port. It exposes nothing to the page and keeps no way back to main: after this
 * runs, the only thing connecting extension code to the app is that port, whose
 * far end main reads as coming from this extension and no other. Any `ipcMain`
 * channel refuses this renderer anyway (`ipc-sender-guard.ts`), because it is not
 * the app's window.
 *
 * Only `require('electron')`: this runs in a `sandbox: true` renderer.
 */
import { ipcRenderer } from 'electron';

import { SANDBOX_GUEST_URL, SANDBOX_PORT_CHANNEL } from './constants';

/** Held so the Worker cannot be collected while this page exists. */
let worker: Worker | null = null;

ipcRenderer.once(SANDBOX_PORT_CHANNEL, (event) => {
  const [port] = event.ports;
  if (!port) return;
  worker = new Worker(SANDBOX_GUEST_URL);
  // Only a build or packaging mistake gets here. Main logs what reaches the console,
  // and gives up on a sandbox that never says it is ready.
  worker.onerror = (error) => console.error(`The extension Worker failed: ${error.message}`);
  worker.postMessage('start', [port]);
});
