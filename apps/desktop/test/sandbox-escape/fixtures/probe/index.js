// Every way out of the sandbox this test knows of, tried from real extension code.
// A result starting NOT-BLOCKED fails the run. Add to this list when a new way turns up.
'use strict';
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);
async function attempt(results, name, fn, ms = 2500) {
  try { const v = await withTimeout(Promise.resolve().then(fn), ms); results[name] = 'NOT-BLOCKED: ' + String(v).slice(0, 140); }
  catch (e) { results[name] = 'refused: ' + (e && e.name) + ': ' + String(e && e.message).slice(0, 140); }
}
function capturePort() {
  return new Promise((resolve) => {
    const original = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...a) { MessagePort.prototype.postMessage = original; resolve(this); return original.apply(this, a); };
  });
}
exports.activate = (ctx) => {
  ctx.exports.globals = async () => {
    const out = {};
    for (const g of ['require','process','module','exports','Buffer','global','__dirname','__filename','setImmediate','document','window','parent','top','Image','electron','ipcRenderer','electronAPI','RTCPeerConnection','SharedWorker','Notification','webkitRequestFileSystem','WebSocketStream']) out[g] = typeof self[g];
    out.hid = typeof navigator.hid; out.usb = typeof navigator.usb; out.serial = typeof navigator.serial; out.gpu = typeof navigator.gpu;
    out.location = String(self.location); out.origin = self.origin;
    out.modulePath = typeof __filename === 'string' ? __filename : null;
    out.storagePath = ctx.storagePath;
    return out;
  };
  ctx.exports.files = async (paths) => {
    const r = {};
    const F = paths.canaryTextUrl, FJ = paths.canaryJsUrl, FM = paths.canaryMjsUrl;
    await attempt(r, 'fetch file://', async () => { const x = await fetch(F); return x.status + ' ' + await x.text(); });
    await attempt(r, 'XHR file://', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', F); x.onload = () => res(x.status + ' ' + x.responseText); x.onerror = () => rej(new Error('xhr error')); x.send(); }));
    await attempt(r, 'XHR file:// sync', () => { const x = new XMLHttpRequest(); x.open('GET', F, false); x.send(); return x.status + ' ' + x.responseText; });
    await attempt(r, 'import() file://', async () => JSON.stringify(await import(FM)));
    await attempt(r, 'importScripts file://', () => { importScripts(FJ); return String(self.__canaryLoaded); });
    await attempt(r, 'new Worker file://', () => new Promise((res, rej) => { const w = new Worker(FJ); w.onerror = () => rej(new Error('worker onerror')); w.onmessage = (e) => res(JSON.stringify(e.data)); }));
    await attempt(r, 'nested blob Worker reading file://', () => new Promise((res, rej) => {
      const u = URL.createObjectURL(new Blob(['fetch(' + JSON.stringify(F) + ').then(r=>r.text()).then(t=>postMessage(t),e=>postMessage("refused "+e.message))'], { type: 'text/javascript' }));
      const w = new Worker(u); w.onerror = () => rej(new Error('nested worker refused to start')); w.onmessage = (e) => res(e.data);
    }));
    await attempt(r, 'nested same-origin Worker', () => new Promise((res, rej) => {
      const w = new Worker(self.location.href); w.onerror = () => rej(new Error('nested worker refused to start')); w.onmessage = (e) => res(JSON.stringify(e.data)); setTimeout(() => res('started'), 800);
    }));
    await attempt(r, 'blob importScripts', () => { const u = URL.createObjectURL(new Blob(['self.__blobRan=1'], { type: 'text/javascript' })); importScripts(u); return self.__blobRan; });
    await attempt(r, 'data: importScripts', () => { importScripts('data:text/javascript,self.__dataRan=1'); return self.__dataRan; });
    await attempt(r, 'eval', () => eval('1+1'));
    await attempt(r, 'new Function', () => new Function('return 1')());
    await attempt(r, "require('fs')", () => require('fs'));
    await attempt(r, "require('node:fs')", () => require('node:fs'));
    await attempt(r, "require('child_process')", () => require('child_process'));
    await attempt(r, "require('electron')", () => require('electron'));
    await attempt(r, "require('../../../x.js') climbing out", () => require('../../../../x.js'));
    await attempt(r, 'bare process.env', () => process.env.HOME);
    await attempt(r, 'importScripts of extension path with ..', () => { importScripts('sarv-extension-sandbox://guest/ext/../../../../../' + paths.canaryJsPath); return String(self.__canaryLoaded); });
    await attempt(r, 'importScripts of encoded ..', () => { importScripts('sarv-extension-sandbox://guest/ext/%2e%2e%2f%2e%2e%2f' + encodeURIComponent(paths.canaryJsPath)); return String(self.__canaryLoaded); });
    await attempt(r, 'importScripts absolute path under ext', () => { importScripts('sarv-extension-sandbox://guest/ext/' + encodeURIComponent(paths.canaryJsPath)); return String(self.__canaryLoaded); });
    await attempt(r, 'importScripts backslash traversal', () => { importScripts('sarv-extension-sandbox://guest/ext/..%5C..%5C' + encodeURIComponent(paths.canaryJsPath)); return String(self.__canaryLoaded); });
    await attempt(r, 'importScripts other extension scheme', () => { importScripts('sarv-extension://victim/index.js'); return 'ran'; });
    await attempt(r, 'fetch other extension scheme', async () => (await fetch('sarv-extension://victim/index.js')).status);
    await attempt(r, 'fetch own module (reading own source)', async () => (await fetch('sarv-extension-sandbox://guest/ext/index.js')).status);
    await attempt(r, 'fetch sarv-attachment', async () => (await fetch('sarv-attachment://x/y')).status);
    return r;
  };
  ctx.exports.network = async ({ http, ws, udp }) => {
    const r = {};
    await attempt(r, 'fetch', async () => { const x = await fetch(http + '/fetch'); return x.status + ' ' + await x.text(); });
    await attempt(r, 'fetch no-cors', async () => (await fetch(http + '/fetch-nocors', { mode: 'no-cors' })).type);
    await attempt(r, 'fetch public https', async () => (await fetch('https://example.com/')).status, 4000);
    await attempt(r, 'XHR', () => new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open('GET', http + '/xhr'); x.onload = () => res(x.status); x.onerror = () => rej(new Error('xhr error')); x.send(); }));
    await attempt(r, 'WebSocket', () => new Promise((res, rej) => { const w = new WebSocket(ws + '/ws'); w.onopen = () => res('open'); w.onerror = () => rej(new Error('ws error')); }));
    await attempt(r, 'WebSocketStream', async () => { if (typeof WebSocketStream === 'undefined') throw new Error('API absent'); const s = new WebSocketStream(ws + '/wss'); await s.opened; return 'open'; });
    await attempt(r, 'WebTransport', async () => { if (typeof WebTransport === 'undefined') throw new Error('API absent'); const t = new WebTransport('https://127.0.0.1:' + udp + '/wt'); await t.ready; return 'ready'; }, 3000);
    await attempt(r, 'EventSource', () => new Promise((res, rej) => { const e = new EventSource(http + '/sse'); e.onmessage = (m) => res('msg ' + m.data); e.onerror = () => rej(new Error('es error')); }));
    await attempt(r, 'new Image', () => { if (typeof Image === 'undefined') throw new Error('Image does not exist in a Worker'); const i = new Image(); i.src = http + '/img.png'; return 'created'; });
    await attempt(r, 'createImageBitmap via fetch', async () => (await createImageBitmap(await (await fetch(http + '/img2.png')).blob())).width);
    await attempt(r, 'FontFace', async () => { await new FontFace('x', 'url(' + http + '/font.woff2)').load(); return 'loaded'; });
    await attempt(r, 'importScripts http', () => { importScripts(http + '/importscripts.js'); return 'ran'; });
    await attempt(r, 'import() http', async () => { await import(http + '/import.js'); return 'imported'; });
    await attempt(r, 'new Worker http', () => new Promise((res, rej) => { const w = new Worker(http + '/worker.js'); w.onerror = () => rej(new Error('worker onerror')); w.onmessage = (e) => res(e.data); setTimeout(() => res('no message'), 800); }));
    await attempt(r, 'nested blob Worker fetching', () => new Promise((res, rej) => {
      const u = URL.createObjectURL(new Blob(['fetch(' + JSON.stringify(http + '/nested') + ').then(r=>postMessage("fetched "+r.status),e=>postMessage("refused "+e.message))'], { type: 'text/javascript' }));
      const w = new Worker(u); w.onerror = () => rej(new Error('nested worker refused to start')); w.onmessage = (e) => res(e.data);
    }));
    await attempt(r, 'navigator.sendBeacon', () => { if (!navigator.sendBeacon) throw new Error('sendBeacon does not exist in a Worker'); return navigator.sendBeacon(http + '/beacon', 'x'); });
    await attempt(r, 'RTCPeerConnection', () => { if (typeof RTCPeerConnection === 'undefined') throw new Error('RTCPeerConnection does not exist in a Worker'); return 'present'; });
    await attempt(r, 'Notification', async () => { if (typeof Notification === 'undefined') throw new Error('API absent'); return Notification.permission; });
    await attempt(r, 'context.network without network:fetch', async () => { const x = await ctx.network.fetch('https://example.com/'); return x.status; });
    return r;
  };
  ctx.exports.state = async () => {
    self.__state = 'PROBE-GLOBAL-SECRET';
    const bc = new BroadcastChannel('shared'); self.__bc = bc; self.__heard = null; bc.onmessage = (e) => { self.__heard = e.data; };
    await new Promise((res) => { const r = indexedDB.open('shared', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const t = r.result.transaction('s', 'readwrite'); t.objectStore('s').put('PROBE-IDB-SECRET', 'k'); t.oncomplete = res; }; });
    const c = await caches.open('shared'); await c.put(new Request('sarv-extension-sandbox://guest/k'), new Response('PROBE-CACHE-SECRET')).catch(() => {});
    return 'written';
  };
  ctx.exports.heard = async () => self.__heard;
  ctx.exports.forge = async (victimId) => {
    // The strongest thing an extension can do on its own thread: get at the raw port.
    const portPromise = capturePort();
    ctx.log.info('tick so the port is used');
    const port = await portPromise;
    const replies = {};
    const listen = (e) => { if (e.data && e.data.type === 'host-reply' && String(e.data.requestId).startsWith('forged')) replies[e.data.requestId] = e.data; };
    port.addEventListener('message', listen);
    port.postMessage({ type: 'host-call', requestId: 'forged-read', extensionId: victimId, method: 'storage.get', args: ['secret'] });
    port.postMessage({ type: 'host-call', requestId: 'forged-own-perm', extensionId: 'probe', method: 'mail.trash', args: ['email-1'] });
    port.postMessage({ type: 'host-call', requestId: 'forged-wf-drop', extensionId: 'probe', method: 'workflow.unregister', args: [victimId + '.w'] });
    port.postMessage({ type: 'host-call', requestId: 'forged-wf-add', extensionId: 'probe', method: 'workflow.register', args: [{ fullId: victimId + '.evil', id: 'evil', name: 'evil' }] });
    port.postMessage({ type: 'log', extensionId: victimId, level: 'error', message: 'FORGED-LOG-LINE' });
    port.postMessage({ type: 'invoke-reply', requestId: 'inv-1', ok: true, value: { success: true, labelsToAdd: ['forged'] } });
    await new Promise((r) => setTimeout(r, 500));
    port.removeEventListener('message', listen);
    return replies;
  };
  // A served file hands its wrapper to this function, whatever the file holds.
  ctx.exports.steal = async () => {
    const out = {};
    self.__sarvDefineModule = (p, f) => { out.stolenSource = String(f); };
    try { importScripts('sarv-extension-sandbox://guest/ext/link.js'); out.linkJs = 'loaded'; } catch (e) { out.linkJs = 'refused: ' + e.name; }
    try { importScripts('sarv-extension-sandbox://guest/ext/linkdir/canary.js'); out.linkDir = 'loaded'; } catch (e) { out.linkDir = 'refused: ' + e.name; }
    return out;
  };
  ctx.exports.ping = async () => 'alive';
  ctx.exports.hang = () => { for (;;) {} };
  ctx.exports.oom = () => { const a = []; for (;;) a.push(new Array(1e6).fill(Math.random())); };
  ctx.exports.closeSelf = async () => { setTimeout(() => self.close(), 50); return 'closing'; };
  ctx.exports.throwLater = async () => { setTimeout(() => { throw new Error('uncaught from a timer'); }, 0); return 'thrown'; };
  ctx.exports.echoError = async () => { throw new TypeError('kept message'); };
  ctx.exports.notCloneable = async () => () => 1;
};
