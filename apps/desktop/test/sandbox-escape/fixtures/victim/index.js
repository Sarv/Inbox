'use strict';
exports.activate = async (ctx) => {
  await ctx.storage.set('secret', 'VICTIM-STORAGE-SECRET');
  ctx.registerWorkflow({ id: 'w', name: 'Victim wf', priority: 50, shouldProcess: async () => true, process: async () => ({ success: true, labelsToAdd: ['victim-ran'] }) });
  ctx.exports.ping = async () => 'victim alive';
  ctx.exports.readState = async () => {
    const out = {};
    out.global = typeof self.__state;
    const bc = new BroadcastChannel('shared'); const heard = new Promise((res) => { bc.onmessage = (e) => res(e.data); setTimeout(() => res(null), 400); });
    out.broadcastHeard = await heard;
    out.idb = await new Promise((res) => { const r = indexedDB.open('shared', 1); r.onupgradeneeded = () => r.result.createObjectStore('s'); r.onsuccess = () => { const g = r.result.transaction('s').objectStore('s').get('k'); g.onsuccess = () => res(g.result ?? null); }; });
    out.cacheKeys = await caches.keys();
    return out;
  };
  ctx.exports.shout = async () => { const bc = new BroadcastChannel('shared'); bc.postMessage('VICTIM-BROADCAST-SECRET'); return 'sent'; };
  ctx.exports.storageValue = async () => ctx.storage.get('secret');
};
