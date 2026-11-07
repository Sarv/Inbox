/**
 * The escape test: hostile extension code against the real sandbox, in real Electron.
 *
 * The unit tests pin the settings. They cannot say whether those settings stop a fetch:
 * only Chromium can, and that can change under any Electron upgrade with nothing in the
 * diff to show for it. So this runs the real transport, host and bundled Worker from
 * inside an `app.asar`, against real listeners on HTTP, WebSocket and UDP, and fails if
 * anything gets out. Run with `pnpm --filter @sarvinbox/desktop test:sandbox-escape`.
 *
 * Failing means the sandbox has a hole on this platform and this Electron. Do not
 * loosen a check to get past it.
 */
import * as dgram from 'node:dgram';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createEventBus, ExtensionManager } from '@sarvinbox/core';
import { app, BrowserWindow, ipcMain, protocol, session, WebContentsView, webContents } from 'electron';

import { downloadScanners, isScannerExtensionAvailable } from '../../electron/services/attachment-download-protection';
import { createExtensionNetworkBackend } from '../../electron/services/extension-network-backend';
import { createSandboxChannel, SANDBOX_SCHEME_PRIVILEGES, sandboxPartition } from '../../electron/services/extension-runtime';
import { installIpcSenderGuard } from '../../electron/utils/ipc-sender-guard';

const FIXTURES = process.env.SANDBOX_ESCAPE_FIXTURES as string;
const WORK = process.env.SANDBOX_ESCAPE_WORK as string;
const SCENARIO = process.env.SANDBOX_ESCAPE_SCENARIO ?? 'escapes';

app.setName('sarv-inbox-sandbox-escape');
app.setPath('userData', path.join(WORK, 'userData'));
protocol.registerSchemesAsPrivileged([SANDBOX_SCHEME_PRIVILEGES]);
installIpcSenderGuard(ipcMain as never, {
  mainWindow: () => null,
  appUrl: () => 'file:///nothing',
});

const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? 'ok    ' : 'FAILED'} ${name}${ok || detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  if (!ok) failures.push(name);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(fn: () => T, ms: number): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await sleep(25);
  }
  return null;
}
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// By name, because a probe that threw before it finished returns `{ threw }`, and a check
// over whatever came back would pass on that with nothing tried at all.
const FILE_PROBES = [
  'fetch file://',
  'XHR file://',
  'XHR file:// sync',
  'import() file://',
  'importScripts file://',
  'new Worker file://',
  'nested blob Worker reading file://',
  'nested same-origin Worker',
  'blob importScripts',
  'data: importScripts',
  'eval',
  'new Function',
  "require('fs')",
  "require('node:fs')",
  "require('child_process')",
  "require('electron')",
  "require('../../../x.js') climbing out",
  'bare process.env',
  'importScripts of extension path with ..',
  'importScripts of encoded ..',
  'importScripts absolute path under ext',
  'importScripts backslash traversal',
  'importScripts other extension scheme',
  'fetch other extension scheme',
  'fetch own module (reading own source)',
  'fetch sarv-attachment',
];
const NETWORK_PROBES = [
  'fetch',
  'fetch no-cors',
  'fetch public https',
  'XHR',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'EventSource',
  'new Image',
  'createImageBitmap via fetch',
  'FontFace',
  'importScripts http',
  'import() http',
  'new Worker http',
  'nested blob Worker fetching',
  'navigator.sendBeacon',
  'RTCPeerConnection',
  'Notification',
  'context.network without network:fetch',
];
function checkEveryProbeRan(group: string, expected: string[], results: Record<string, string>): void {
  const missing = expected.filter((name) => !(name in results));
  check(`${group}: every probe ran`, missing.length === 0 && !('threw' in results), { missing, threw: results.threw });
}

const problems: { extensionId: string; body: string }[] = [];
function newManager(base: string): ExtensionManager {
  return new ExtensionManager({
    extensionsBaseDir: base,
    eventBus: createEventBus(),
    uiBackend: {
      notify: () => undefined,
      dismiss: () => undefined,
      reportProblem: (extensionId, card) => problems.push({ extensionId, body: String(card.body) }),
    },
    networkBackend: createExtensionNetworkBackend(),
    createChannel: createSandboxChannel,
  });
}

async function call<T>(manager: ExtensionManager, id: string, fn: string, ...args: unknown[]): Promise<T | { threw: string }> {
  try {
    return await manager.callExtensionFunction<T>(id, fn, ...args);
  } catch (error) {
    return { threw: (error as Error).message };
  }
}

function sandboxOf(id: string): Electron.WebContents | undefined {
  const ses = session.fromPartition(sandboxPartition(id), { cache: false });
  return webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.session === ses);
}

async function escapes(): Promise<void> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`http ${req.url}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', req.url?.includes('sse') ? 'text/event-stream' : 'text/javascript');
    res.end(req.url?.includes('sse') ? 'data: hi\n\n' : 'self.__netScript=1;');
  });
  server.on('upgrade', (req, socket) => {
    hits.push(`ws ${req.url}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // WebTransport is QUIC: webRequest does not see it, so only UDP can tell if one left.
  const udp = dgram.createSocket('udp4');
  udp.on('message', () => hits.push('udp'));
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve));
  const httpPort = (server.address() as AddressInfo).port;

  const outside = path.join(WORK, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const canary = (name: string, content: string): string => {
    const file = path.join(outside, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const canaryText = canary('canary.txt', 'TOP-SECRET-CANARY');
  const canaryJs = canary('canary.js', 'self.__canaryLoaded = true; globalThis.SECRET = "TOP-SECRET-CANARY";');
  const canaryMjs = canary('canary.mjs', 'export const x = "TOP-SECRET-CANARY";');
  const paths = {
    canaryTextUrl: pathToFileURL(canaryText).href,
    canaryJsUrl: pathToFileURL(canaryJs).href,
    canaryMjsUrl: pathToFileURL(canaryMjs).href,
    canaryJsPath: canaryJs,
  };

  const manager = newManager(path.join(WORK, 'data'));
  await manager.initialize();
  await manager.installExtension(path.join(FIXTURES, 'probe'));
  await manager.installExtension(path.join(FIXTURES, 'victim'));

  const probe = sandboxOf('probe') as Electron.WebContents;
  const victim = sandboxOf('victim') as Electron.WebContents;
  const probePid = probe.getOSProcessId();
  check('each extension has its own renderer', probePid !== victim.getOSProcessId());
  check('a sandbox is not a window', BrowserWindow.getAllWindows().length === 0);
  const ses = session.fromPartition(sandboxPartition('probe'), { cache: false });
  check('its session is in memory', !ses.isPersistent() && ses.storagePath === null);

  const globals = (await call<Record<string, string>>(manager, 'probe', 'globals')) as Record<string, string>;
  for (const name of ['require', 'process', 'Buffer', 'global', 'document', 'window', 'Image', 'electron', 'ipcRenderer']) {
    check(`no ${name} in the Worker`, globals[name] === 'undefined', globals[name]);
  }
  check('no real path reaches the extension', !String(globals.modulePath).includes(path.sep === '\\' ? 'C:' : WORK), globals.modulePath);

  const files = (await call<Record<string, string>>(manager, 'probe', 'files', paths)) as Record<string, string>;
  checkEveryProbeRan('files', FILE_PROBES, files);
  for (const [name, result] of Object.entries(files)) {
    check(`files: ${name}`, !String(result).startsWith('NOT-BLOCKED') && !String(result).includes('CANARY'), result);
  }

  const network = (await call<Record<string, string>>(manager, 'probe', 'network', {
    http: `http://127.0.0.1:${httpPort}`,
    ws: `ws://127.0.0.1:${httpPort}`,
    udp: udp.address().port,
  })) as Record<string, string>;
  checkEveryProbeRan('network', NETWORK_PROBES, network);
  for (const [name, result] of Object.entries(network)) {
    check(`network: ${name}`, !String(result).startsWith('NOT-BLOCKED'), result);
  }
  check('network: without the permission, the host API refuses', String(network['context.network without network:fetch']).includes('network:fetch'));

  // Code that somehow ran in the page rather than the Worker.
  const inPage = (await probe.executeJavaScript(`(async () => {
    const out = { require: typeof require, process: typeof process, ipcRenderer: typeof ipcRenderer };
    await new Promise((r) => { const i = new Image(); i.onload = () => { out.img = 'loaded'; r(); }; i.onerror = () => { out.img = 'blocked'; r(); }; i.src = 'http://127.0.0.1:${httpPort}/page-img.png'; setTimeout(r, 800); });
    const f = document.createElement('iframe'); f.src = 'http://127.0.0.1:${httpPort}/page-frame'; document.body.appendChild(f);
    window.open('http://127.0.0.1:${httpPort}/popup');
    location.href = 'http://127.0.0.1:${httpPort}/nav';
    await new Promise((r) => setTimeout(r, 400));
    return out;
  })()`).catch((error: Error) => ({ error: error.message }))) as Record<string, string>;
  check('page: no Node, no IPC', inPage.require === 'undefined' && inPage.process === 'undefined' && inPage.ipcRenderer === 'undefined', inPage);
  check('page: an image load is blocked', inPage.img !== 'loaded', inPage);
  check('page: it cannot navigate', probe.getURL() === 'sarv-extension-sandbox://guest/index.html', probe.getURL());

  await sleep(1000);
  check('NOTHING LEFT: no request, socket or datagram reached a listener', hits.length === 0, hits);

  // One extension and another.
  await call(manager, 'probe', 'state');
  await call(manager, 'victim', 'shout');
  await sleep(300);
  check('state: a broadcast does not reach another extension', (await call(manager, 'probe', 'heard')) === null);
  const seen = (await call<Record<string, unknown>>(manager, 'victim', 'readState')) as Record<string, unknown>;
  check('state: another extension reads no global, IndexedDB or cache', seen.global === 'undefined' && seen.idb === null && (seen.cacheKeys as unknown[]).length === 0, seen);

  const before = manager.getHost().getAllWorkflowAdapters().map((adapter) => adapter.id).join();
  const forged = (await call<Record<string, { ok: boolean; error?: { message: string } }>>(manager, 'probe', 'forge', 'victim')) as Record<string, { ok: boolean; error?: { message: string } }>;
  for (const id of ['forged-read', 'forged-own-perm', 'forged-wf-drop', 'forged-wf-add']) {
    check(`forged protocol message refused: ${id}`, forged[id]?.ok === false, forged[id]);
  }
  check('forging changed no workflow', manager.getHost().getAllWorkflowAdapters().map((adapter) => adapter.id).join() === before);
  check('forging touched no other extension', (await call(manager, 'victim', 'storageValue')) === 'VICTIM-STORAGE-SECRET');

  // IPC, from a renderer configured the same way but handed ipcRenderer.
  ipcMain.handle('sandbox-escape:secret', () => 'SECRET FROM MAIN');
  const preload = path.join(WORK, 'ipc-preload.js');
  fs.writeFileSync(preload, `const { ipcRenderer, contextBridge } = require('electron'); contextBridge.exposeInMainWorld('tryIpc', () => ipcRenderer.invoke('sandbox-escape:secret'));`);
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, preload } });
  await view.webContents.loadURL('sarv-extension-sandbox://guest/index.html');
  const ipcResult = (await view.webContents.executeJavaScript(`window.tryIpc().then((v) => 'GOT ' + v, (e) => 'refused: ' + e.message)`)) as string;
  check('IPC: ipcMain refuses a renderer that is not the app window', ipcResult.startsWith('refused'), ipcResult);
  view.webContents.close();

  // Links, into a file and into a folder.
  let linked = true;
  const linkedDir = path.join(WORK, 'data', 'extensions', 'probe');
  try {
    fs.symlinkSync(canaryJs, path.join(linkedDir, 'link.js'));
    fs.symlinkSync(outside, path.join(linkedDir, 'linkdir'));
  } catch {
    linked = false; // Windows without the privilege to create one.
  }
  if (linked) {
    await manager.getHost().reload('probe');
    const stolen = (await call<Record<string, string>>(manager, 'probe', 'steal')) as Record<string, string>;
    check('links: a link in the folder serves nothing', !String(stolen.linkJs).startsWith('loaded') && !String(stolen.linkDir).startsWith('loaded') && !stolen.stolenSource, stolen);
  } else {
    console.log('skip   links: this account may not create symbolic links');
  }

  // A crash in one takes nobody with it.
  const pidBefore = (sandboxOf('probe') as Electron.WebContents).getOSProcessId();
  const oom = (await call<unknown>(manager, 'probe', 'oom')) as { threw?: string };
  check('out of memory: the call ends with a reason', String(oom.threw).includes('stopped'), oom);
  check('out of memory: its renderer is gone', (await until(() => !isAlive(pidBefore), 5000)) === true);
  check('out of memory: another extension still answers', (await call(manager, 'victim', 'ping')) === 'victim alive');

  // A hang is killed, and the other keeps working while it spins.
  await manager.getHost().reload('probe');
  const hungPid = (sandboxOf('probe') as Electron.WebContents).getOSProcessId();
  const started = Date.now();
  const hanging = call<unknown>(manager, 'probe', 'hang');
  await sleep(500);
  check('hang: another extension answers while it spins', (await call(manager, 'victim', 'ping')) === 'victim alive');
  const hung = (await hanging) as { threw?: string };
  check('hang: killed within 40 seconds, and says so', Date.now() - started < 40_000 && String(hung.threw).includes('stopped responding'), hung);
  check('hang: its renderer is gone', (await until(() => !isAlive(hungPid), 5000)) === true);
  check('hang: told to the user', problems.some((problem) => problem.extensionId === 'probe' && problem.body.includes('stopped responding')));

  await manager.getHost().reload('probe');
  check('a stopped extension comes back when asked', (await call(manager, 'probe', 'ping')) === 'alive');

  await manager.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  udp.close();
  check('shutting down leaves no sandbox', webContents.getAllWebContents().filter((contents) => !contents.isDestroyed()).length === 0);
}

/**
 * The other half of the promise: an extension "takes down nothing but itself". The escape
 * test says nothing got out; every attack here got nothing out, and still took the app
 * down, in a loop, because extensions start before the window. So each one runs against
 * this process, and the question after it is whether this process is still all right.
 */
async function availability(): Promise<void> {
  // Well over what it uses, well under what any of these reached before they were fixed
  // (7.7 GB, or dead). Twice the largest string, which main does hold for a moment.
  const MAX_RSS = 1_500 * 1024 * 1024;
  // CI machines are slow, but these reached 18 seconds and more.
  const MAX_STALL_MS = 10_000;

  const fixture = path.join(WORK, 'flood');
  fs.cpSync(path.join(FIXTURES, 'flood'), fixture, { recursive: true });
  fs.writeFileSync(path.join(fixture, 'big.js'), `self.__big = "${'x'.repeat(15 * 1024 * 1024)}";`);

  const manager = newManager(path.join(WORK, 'data-availability'));
  await manager.initialize();
  await manager.installExtension(fixture);
  await manager.installExtension(path.join(FIXTURES, 'victim'));

  let stall = 0;
  let tick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    stall = Math.max(stall, now - tick - 100);
    tick = now;
  }, 100);

  const surface = (await call<Record<string, string>>(manager, 'flood', 'surface')) as Record<string, string>;
  // Writing to these filled main's memory (OPFS: 3 GB in, 2.2 GB in main), or they are a line
  // to a process with no need of one. `emit` was a way to make main do work for nothing.
  for (const name of ['emit', 'getDirectory', 'gpu', 'serial', 'storageBuckets', 'FileSystemDirectoryHandle', 'GPU', 'SerialPort']) {
    check(`gone from the Worker: ${name}`, surface[name] === 'undefined', surface);
  }

  const attacks = ['consoleLoop', 'consoleBurst', 'importFlood', 'retainWorkflows', 'longIds', 'bigMessages', 'hugeStorage', 'hugeHidden', 'hugeSetting', 'hugeReply', 'hugeThrow'];
  for (const attack of attacks) {
    await manager.getHost().reload('flood');
    stall = 0;
    tick = Date.now();
    // Not awaited: most of these never answer, because they do not live that long.
    const outcome = call(manager, 'flood', attack);
    await Promise.race([outcome, sleep(1000)]);
    // The one exception: asking for a file with a query string is simply refused now, and
    // nothing was served, so there is nothing to stop it for.
    if (attack !== 'importFlood') {
      const stopped = await until(() => manager.getExtensionInfo('flood')?.state !== 'active', 45_000);
      check(`${attack}: it is stopped`, Boolean(stopped), manager.getExtensionInfo('flood')?.state);
    }
    check(`${attack}: another extension still answers`, (await call(manager, 'victim', 'ping')) === 'victim alive');
    const rss = process.memoryUsage().rss;
    check(`${attack}: main kept its memory`, rss < MAX_RSS, `${Math.round(rss / 1024 / 1024)} MB`);
    check(`${attack}: main kept responding`, stall < MAX_STALL_MS, `${stall} ms`);
    check(`${attack}: nothing was stored`, !fs.existsSync(path.join(WORK, 'data-availability', 'extension-storage', 'flood', 'storage.json')) || fs.statSync(path.join(WORK, 'data-availability', 'extension-storage', 'flood', 'storage.json')).size < 1024 * 1024);
  }

  // A crash is not the extension's choice and may not recur, so it comes back. A deliberate
  // kill is the opposite: the last attack above is still off, and restarting it would just
  // start the attack again.
  await manager.getHost().reload('flood');
  await call(manager, 'flood', 'consoleLoop');
  await until(() => manager.getExtensionInfo('flood')?.state !== 'active', 45_000);
  await sleep(3000);
  check('a deliberate kill: it stays off', manager.getExtensionInfo('flood')?.state !== 'active', manager.getExtensionInfo('flood')?.state);

  await manager.getHost().reload('flood');
  const crashedPid = (sandboxOf('flood') as Electron.WebContents).getOSProcessId();
  (sandboxOf('flood') as Electron.WebContents).forcefullyCrashRenderer();
  await until(() => manager.getExtensionInfo('flood')?.state !== 'active', 5000);
  const back = await until(() => manager.getExtensionInfo('flood')?.state === 'active', 10_000);
  check('a crashed renderer: it comes back by itself', Boolean(back) && sandboxOf('flood')?.getOSProcessId() !== crashedPid, manager.getExtensionInfo('flood')?.state);
  check('a crashed renderer: it works again', (await call(manager, 'flood', 'ping')) === 'alive');

  // The worst of them as a line of console output: Chromium decides how much of it reaches main.
  await manager.getHost().reload('flood');
  await call(manager, 'flood', 'consoleHuge');
  await sleep(2000);
  check('one enormous console line: another extension still answers', (await call(manager, 'victim', 'ping')) === 'victim alive');

  // A panel gets to main without the bridge. A real flat string, or stringifying would survive it.
  const huge = Buffer.alloc(300 * 1024 * 1024, 120).toString('latin1');
  await manager.getHost().reload('flood');
  const panel = await manager.getHost().servePanelRequest('flood', {
    requestId: 'r',
    method: 'storage.set',
    params: { key: 'big', value: huge },
  } as never);
  check('a panel: an enormous request is refused', panel.ok === false && panel.error === 'This request is too large', panel.ok);

  clearInterval(timer);
  await manager.shutdown();
}

/** Launched with `--no-sandbox`: extension code must not start, and the user is told. */
async function refusal(): Promise<void> {
  check('launched with --no-sandbox', app.commandLine.hasSwitch('no-sandbox'));
  const manager = newManager(path.join(WORK, 'data-refusal'));
  await manager.initialize();
  const outcome = await manager.installExtension(path.join(FIXTURES, 'victim')).then(
    () => 'installed',
    (error: Error) => error.message
  );
  check('release build refuses to run extension code', outcome.includes('operating system sandbox'), outcome);
  check('the extension is off, and says why', manager.getExtensionInfo('victim')?.state === 'error');
  check('the user is told', problems.some((problem) => problem.body.includes('operating system sandbox')));

  // Scanning is the host's work. Tying it to this code cost antivirus users every attachment
  // on any machine like this one, with a scanner that was perfectly able to scan.
  const scanner = path.join(WORK, 'scanner');
  fs.cpSync(path.join(FIXTURES, 'victim'), scanner, { recursive: true });
  const scannerManifest = JSON.parse(fs.readFileSync(path.join(scanner, 'sarvinbox-extension.json'), 'utf8'));
  fs.writeFileSync(
    path.join(scanner, 'sarvinbox-extension.json'),
    JSON.stringify({ ...scannerManifest, id: 'scanner', permissions: [...scannerManifest.permissions, 'security:scan-attachments'] })
  );
  await manager.installExtension(scanner).catch(() => undefined);
  check('a scanner whose code cannot start is off, and says why', manager.getExtensionInfo('scanner')?.state === 'error');
  check('a scanner whose code cannot start can still scan', isScannerExtensionAvailable(manager, 'scanner'));
  check('a scanner whose code cannot start is still counted as present', downloadScanners(manager).some((entry) => entry.id === 'scanner' && entry.active));

  await manager.shutdown();
}

const SCENARIOS: Record<string, () => Promise<void>> = { escapes, availability, refusal };

void app.whenReady().then(async () => {
  try {
    await SCENARIOS[SCENARIO]();
  } catch (error) {
    check(`the ${SCENARIO} scenario ran to the end`, false, (error as Error).stack);
  }
  console.log(failures.length === 0 ? 'SANDBOX_ESCAPE_PASSED' : `${failures.length} FAILED`);
  // After a macrotask: this also proves a real quit, once torn down, does not crash.
  setTimeout(() => app.exit(failures.length === 0 ? 0 : 1), 0);
});
