// Every way this test knows of for an extension to take the APP down, as opposed to getting
// out. Each was found to work once: a crash loop, because extensions start before the window.
// `harness.ts` runs each one, then asks whether the app is still here.
'use strict';
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function capturePort(ctx) {
  return new Promise((resolve) => {
    const original = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (...args) {
      MessagePort.prototype.postMessage = original;
      resolve(this);
      return original.apply(this, args);
    };
    ctx.log.info('tick');
  });
}
const later = (fn) => {
  setTimeout(fn, 0);
  return 'started';
};

exports.activate = (ctx) => {
  ctx.exports.ping = async () => 'alive';

  ctx.exports.surface = async () => ({
    emit: typeof ctx.events.emit,
    getDirectory: typeof navigator.storage.getDirectory,
    gpu: typeof navigator.gpu,
    serial: typeof navigator.serial,
    storageBuckets: typeof navigator.storageBuckets,
    FileSystemDirectoryHandle: typeof self.FileSystemDirectoryHandle,
    GPU: typeof self.GPU,
    SerialPort: typeof self.SerialPort,
  });

  // Each console line is an IPC to main, and Chromium queues them with no limit.
  ctx.exports.consoleLoop = async () => later(() => {
    for (;;) console.log('x');
  });
  ctx.exports.consoleBurst = async () => later(async () => {
    for (;;) {
      for (let i = 0; i < 50000; i += 1) console.log('spam ' + i);
      await sleep(50);
    }
  });
  ctx.exports.consoleHuge = async () => later(() => console.log('x'.repeat(300 * MB)));

  // The file is served from main, and a query string made it a new module each time.
  ctx.exports.importFlood = async () => later(() => {
    for (let i = 0; i < 400; i += 1) import('./big.js?n=' + i).catch(() => undefined);
  });

  // Registering costs main to keep, and needs only email:read.
  ctx.exports.retainWorkflows = async () => {
    const port = await capturePort(ctx);
    const pad = 'x'.repeat(5 * MB);
    return later(async () => {
      for (let i = 0; i < 3000; i += 1) {
        port.postMessage({
          type: 'host-call',
          requestId: 'r' + i,
          extensionId: 'flood',
          method: 'workflow.register',
          args: [{ fullId: 'flood.w' + i, id: 'w' + i, name: 'w', description: pad + i }],
        });
        await sleep(5);
      }
    });
  };
  ctx.exports.longIds = async () => {
    const port = await capturePort(ctx);
    const pad = 'y'.repeat(MB);
    for (let i = 0; i < 200; i += 1) {
      port.postMessage({
        type: 'host-call',
        requestId: 'l' + i,
        extensionId: 'flood',
        method: 'workflow.register',
        args: [{ fullId: 'flood.' + pad + i, id: pad + i, name: 'w' }],
      });
    }
    return 'sent';
  };

  // One message, one string. JSON.stringify of this in main is a fatal V8 error.
  ctx.exports.hugeStorage = async () => {
    await ctx.storage.set('big', 'x'.repeat(300 * MB));
    return 'stored';
  };
  ctx.exports.hugeHidden = async () => {
    await ctx.storage.set('big', [...new Array(2000).fill({ a: 1 }), { deep: ['x'.repeat(300 * MB)] }]);
    return 'stored';
  };
  ctx.exports.hugeSetting = async () => {
    await ctx.settings.update('big', 'x'.repeat(300 * MB));
    return 'stored';
  };
  ctx.exports.hugeReply = async () => 'x'.repeat(300 * MB);
  ctx.exports.hugeThrow = async () => {
    throw new Error('x'.repeat(300 * MB));
  };

  // Past the 512 MB a window: main stops responding long before a message count matters.
  ctx.exports.bigMessages = async () => {
    const port = await capturePort(ctx);
    const pad = 'x'.repeat(50 * MB);
    return later(async () => {
      for (let i = 0; i < 100000; i += 1) {
        port.postMessage({ type: 'log', extensionId: 'flood', level: 'info', message: pad });
        await sleep(0);
      }
    });
  };
};
