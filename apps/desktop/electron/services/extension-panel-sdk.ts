/**
 * The panel SDK, as source.
 *
 * Served at `sarv-extension://sdk/sarv.js`, so a panel author writes
 * `<script src="sarv-extension://sdk/sarv.js"></script>` and has the API — no
 * package to install, no bundler, no version to keep in step. Shipping it as a
 * string in the bundle rather than a file on disk is deliberate: there is no
 * copy step to forget, it works inside an asar, and the SDK can never drift
 * from the host bridge it talks to, because they are released together.
 *
 * It runs in the panel's own sandboxed origin with no privileges of its own —
 * it is a `postMessage` wrapper. Every call it makes is checked in main.
 */

import { PANEL_BRIDGE_CHANNEL } from '@sarvinbox/core';

/** Filename the SDK is served under. */
export const PANEL_SDK_FILENAME = 'sarv.js';

/**
 * The SDK source.
 *
 * Plain ES2020 in a classic script (no modules), so it works whether the panel
 * uses `<script>` or `<script type="module">`, and so a panel can be a single
 * HTML file with no tooling at all.
 */
export const PANEL_SDK_SOURCE = `/* Sarv Inbox panel SDK */
(function () {
  'use strict';

  var CHANNEL = ${JSON.stringify(PANEL_BRIDGE_CHANNEL)};
  var pending = new Map();
  var listeners = new Map();
  var nextId = 0;

  function request(method, params) {
    var requestId = 'p' + (nextId += 1) + '-' + Date.now().toString(36);
    return new Promise(function (resolve, reject) {
      pending.set(requestId, { resolve: resolve, reject: reject });
      // The host frame is the only possible recipient; '*' because a sandboxed
      // panel has an opaque origin and cannot name its parent's.
      parent.postMessage(
        { channel: CHANNEL, requestId: requestId, method: method, params: params },
        '*'
      );
    });
  }

  function emit(event, payload) {
    var handlers = listeners.get(event);
    if (!handlers) return;
    handlers.forEach(function (handler) {
      try {
        handler(payload);
      } catch (error) {
        // One bad listener must not stop the others, and must not take the
        // panel down with it.
        console.error('[sarv] panel listener failed', error);
      }
    });
  }

  window.addEventListener('message', function (messageEvent) {
    var data = messageEvent.data;
    if (!data || data.channel !== CHANNEL) return;

    if (data.event) {
      emit(data.event, data.payload);
      return;
    }

    var waiting = pending.get(data.requestId);
    if (!waiting) return;
    pending.delete(data.requestId);
    if (data.ok) waiting.resolve(data.value);
    else waiting.reject(new Error(data.error || 'Request failed'));
  });

  var sarv = {
    /** The message the reader currently has open, or null. */
    getCurrentMessage: function () {
      return request('message.current');
    },

    storage: {
      get: function (key) {
        return request('storage.get', { key: key });
      },
      set: function (key, value) {
        return request('storage.set', { key: key, value: value });
      },
      delete: function (key) {
        return request('storage.delete', { key: key });
      },
      keys: function () {
        return request('storage.keys');
      },
    },

    settings: {
      get: function (key) {
        return request('settings.get', { key: key });
      },
      all: function () {
        return request('settings.all');
      },
    },

    /** Call a function this extension's background module exported. */
    call: function (name) {
      var args = Array.prototype.slice.call(arguments, 1);
      return request('exports.call', { name: name, args: args });
    },

    notify: function (notification) {
      return request('ui.notify', notification);
    },

    /** Close this panel. */
    close: function () {
      return request('panel.close');
    },

    /** Ask for a different height. Ignored for a panel the app sizes itself. */
    resize: function (height) {
      return request('panel.resize', { height: height });
    },

    /** Listen for a host event. Returns a function that stops listening. */
    on: function (event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return function () {
        var handlers = listeners.get(event);
        if (handlers) handlers.delete(handler);
      };
    },
  };

  window.sarv = sarv;
})();
`;
