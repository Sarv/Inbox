/**
 * An `ExtensionChannel` pair that never leaves the current process.
 *
 * Two uses, both deliberate:
 *
 * - Tests drive the real sandbox engine over this instead of a stand-in, so
 *   what the suite exercises is the code that ships. A mock of the sandbox
 *   would prove only that the mock agrees with itself.
 * - Headless contexts (the CLI, a non-Electron embedder) have no
 *   `utilityProcess` to fork, and running extensions in-process there is the
 *   same trade the desktop app used to make everywhere.
 *
 * Delivery is asynchronous on purpose. A synchronous hand-off would let a
 * sandbox reply land inside the caller's own `post()` stack frame, so a bug
 * that deadlocks or reenters over a real process boundary would pass here.
 */

import type { ExtensionChannel } from './protocol';

class InProcessChannel implements ExtensionChannel {
  /** Set by the factory once both halves exist. */
  peer!: InProcessChannel;

  private messageHandler: ((message: unknown) => void) | undefined;
  private closeHandler: (() => void) | undefined;
  /** Messages posted before the other end subscribed. */
  private readonly backlog: unknown[] = [];
  private closed = false;

  post(message: unknown): void {
    if (this.closed || this.peer.closed) return;
    // Structured clone, as a real channel would: an extension that mutates an
    // object after posting it must not be able to change what the other side
    // reads, and a value that cannot cross a process boundary has to fail here
    // too rather than only in production.
    const copy = structuredClone(message);
    queueMicrotask(() => this.peer.deliver(copy));
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandler = handler;
    const pending = this.backlog.splice(0, this.backlog.length);
    for (const message of pending) handler(message);
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
    if (this.closed) handler();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
    this.peer.closeFromPeer();
  }

  private closeFromPeer(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }

  private deliver(message: unknown): void {
    if (this.closed) return;
    if (!this.messageHandler) {
      this.backlog.push(message);
      return;
    }
    this.messageHandler(message);
  }
}

export interface ExtensionChannelPair {
  /** Give this end to the bridge (main side). */
  host: ExtensionChannel;
  /** Give this end to `startExtensionSandbox`. */
  sandbox: ExtensionChannel;
}

/** Two ends of one in-memory channel, each posting to the other. */
export function createInProcessChannelPair(): ExtensionChannelPair {
  const host = new InProcessChannel();
  const sandbox = new InProcessChannel();
  host.peer = sandbox;
  sandbox.peer = host;
  return { host, sandbox };
}
