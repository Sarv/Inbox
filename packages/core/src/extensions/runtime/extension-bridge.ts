/**
 * The main-process half of the extension boundary.
 *
 * Holds the channel to the sandbox, turns the app's calls into messages, and
 * services the calls coming the other way. Every inbound `host-call` is
 * dispatched through the extension's real `ExtensionContextImpl` — the same
 * permission-checked wrappers the in-process host used — so moving execution
 * out of main changed where extension code runs and nothing about what it is
 * allowed to do.
 *
 * The bridge is transport-agnostic on purpose. It is handed an
 * `ExtensionChannel` and never learns whether the other end is a
 * `utilityProcess` or an in-memory pair, which is what lets the tests drive the
 * real engine instead of a stand-in.
 */

import type { PipelineEvent } from '../../pipeline/types';
import { createLogger } from '../../utils/logger';
import { withTimeout } from '../../utils/timeout';
import type { ExtensionContextImpl } from '../extension-api';
import type { ExtensionUINotification } from '../types';

import {
  deserializeError,
  serializeError,
  type ExtensionChannel,
  type HostCallMethod,
  type HostToSandboxMessage,
  type SandboxActivationRequest,
  type SandboxInvokeTarget,
  type SandboxSyncState,
  type SandboxToHostMessage,
  type WorkflowDescriptor,
} from './protocol';

/**
 * How long a single call into the sandbox may take before it is abandoned.
 *
 * Generous because a workflow may be waiting on an AI completion, and a false
 * timeout looks exactly like an extension that silently does nothing. The real
 * protection against a wedged sandbox is the crash path — every pending call
 * rejects the moment the channel closes — not this number.
 */
export const DEFAULT_INVOKE_TIMEOUT_MS = 120_000;

const logger = createLogger('extension-bridge');

export interface ExtensionBridgeHooks {
  /** The live, permission-checked context for an extension, if it is active. */
  getContext(extensionId: string): ExtensionContextImpl | undefined;
  /** A workflow registered after activation finished. */
  onWorkflowRegistered(extensionId: string, descriptor: WorkflowDescriptor): void;
  /** A workflow the extension withdrew. */
  onWorkflowUnregistered(extensionId: string, fullId: string): void;
  /** The sandbox went away — every extension it held is no longer running. */
  onSandboxClosed(): void;
}

export interface ExtensionBridgeOptions {
  channel: ExtensionChannel;
  hooks: ExtensionBridgeHooks;
  /** Override for tests that assert the timeout path without waiting for it. */
  invokeTimeoutMs?: number;
}

/** What the sandbox reported after bringing an extension up. */
export interface ActivationOutcome {
  workflows: WorkflowDescriptor[];
  exportNames: string[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class ExtensionBridge {
  private readonly channel: ExtensionChannel;
  private readonly hooks: ExtensionBridgeHooks;
  private readonly invokeTimeoutMs: number;

  private readonly pending = new Map<string, PendingCall>();
  /** Live event subscriptions per extension, so deactivation detaches them. */
  private readonly subscriptions = new Map<string, Map<string, () => void>>();
  private nextId = 0;
  private closed = false;
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;

  constructor(options: ExtensionBridgeOptions) {
    this.channel = options.channel;
    this.hooks = options.hooks;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });

    this.channel.onMessage((raw) => this.receive(raw as SandboxToHostMessage));
    this.channel.onClose(() => this.handleClose());
  }

  /** Resolves once the sandbox has announced itself. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Bring one extension up inside the sandbox. */
  async activate(request: SandboxActivationRequest): Promise<ActivationOutcome> {
    // Bounded: a sandbox that fails to boot must surface as one failed
    // activation, not as an install that hangs with no error anywhere.
    await withTimeout(this.ready, this.invokeTimeoutMs, 'Extension sandbox did not start');
    const requestId = this.newId('act');
    const outcome = await this.awaitReply<ActivationOutcome>(requestId, {
      type: 'activate',
      requestId,
      request,
    });
    return outcome;
  }

  /** Take one extension down, leaving the sandbox itself running. */
  async deactivate(extensionId: string): Promise<void> {
    this.detachSubscriptions(extensionId);
    if (this.closed) return;
    const requestId = this.newId('deact');
    await this.awaitReply<void>(requestId, { type: 'deactivate', requestId, extensionId });
  }

  /** Call into extension code and wait for its answer. */
  async invoke<T>(
    extensionId: string,
    target: SandboxInvokeTarget,
    args: unknown[],
    abortSignal?: AbortSignal
  ): Promise<T> {
    const requestId = this.newId('inv');
    const message: HostToSandboxMessage = { type: 'invoke', requestId, extensionId, target, args };
    // An abort in the pipeline has to reach the extension, not just abandon the
    // promise here: the sandbox turns this into its own AbortSignal so a
    // long-running `process()` can bail out rather than run to completion for a
    // result nobody will read.
    const onAbort = () => this.post({ type: 'abort', requestId });
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.awaitReply<T>(requestId, message);
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
    }
  }

  /** Refresh the values the sandbox has to be able to answer synchronously. */
  pushSyncState(extensionId: string, state: Partial<SandboxSyncState>): void {
    this.post({ type: 'sync-state', extensionId, state });
  }

  /**
   * Ask the sandbox to wind down, then drop the channel.
   *
   * The `shutdown` message is the polite half — it gives each extension's
   * `deactivate()` a chance to run. Closing is the half that is guaranteed:
   * every transport treats a closed channel as the end, so an extension that
   * ignores the message still cannot keep the process alive.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.post({ type: 'shutdown' });
    this.handleClose();
    this.channel.close();
  }

  private newId(prefix: string): string {
    return `${prefix}-${++this.nextId}`;
  }

  private post(message: HostToSandboxMessage): void {
    if (this.closed) return;
    this.channel.post(message);
  }

  /** Send a request and resolve when its matching reply arrives. */
  private awaitReply<T>(requestId: string, message: HostToSandboxMessage): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('Extension sandbox is not running'));
    }
    const call = new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.channel.post(message);
    });
    return withTimeout(
      call,
      this.invokeTimeoutMs,
      `Extension sandbox did not answer within ${this.invokeTimeoutMs}ms`
    ).finally(() => {
      this.pending.delete(requestId);
    });
  }

  private settle(requestId: string, ok: boolean, value: unknown, error?: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (ok) pending.resolve(value);
    else pending.reject(error ?? new Error('Extension call failed'));
  }

  private receive(message: SandboxToHostMessage): void {
    switch (message?.type) {
      case 'ready':
        this.markReady();
        break;
      case 'activated':
        this.settle(message.requestId, true, {
          workflows: message.workflows,
          exportNames: message.exportNames,
        });
        break;
      case 'deactivated':
        this.settle(message.requestId, true, undefined);
        break;
      case 'failed':
        this.settle(message.requestId, false, undefined, deserializeError(message.error));
        break;
      case 'invoke-reply':
        this.settle(
          message.requestId,
          message.ok,
          message.value,
          message.error ? deserializeError(message.error) : undefined
        );
        break;
      case 'host-call':
        void this.serveHostCall(message.requestId, message.extensionId, message.method, message.args);
        break;
      case 'log':
        this.writeExtensionLog(message.extensionId, message.level, message.message);
        break;
      default:
        break;
    }
  }

  /**
   * Extension logs are re-emitted through the app's logger, tagged with the
   * extension they came from, so `app.log` carries one stream rather than two
   * and a misbehaving extension is attributable.
   */
  private writeExtensionLog(
    extensionId: string,
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string
  ): void {
    const line = `[Extension:${extensionId}] ${message}`;
    if (level === 'error') logger.error(line);
    else if (level === 'warn') logger.warn(line);
    else if (level === 'info') logger.info(line);
    else logger.debug(line);
  }

  /**
   * Run one call from the sandbox against the extension's real context.
   *
   * This is the permission boundary. Nothing below reads the sandbox's copy of
   * anything — the context resolved here is the one main built from what the
   * user actually granted at install time, and its wrappers throw before any
   * backend is touched.
   */
  private async serveHostCall(
    requestId: string,
    extensionId: string,
    method: HostCallMethod,
    args: unknown[]
  ): Promise<void> {
    try {
      const context = this.hooks.getContext(extensionId);
      if (!context) throw new Error(`Extension ${extensionId} is not active`);
      const value = await this.dispatchHostCall(context, extensionId, method, args);
      this.post({ type: 'host-reply', requestId, ok: true, value });
    } catch (error) {
      this.post({ type: 'host-reply', requestId, ok: false, error: serializeError(error) });
    }
  }

  private async dispatchHostCall(
    context: ExtensionContextImpl,
    extensionId: string,
    method: HostCallMethod,
    args: unknown[]
  ): Promise<unknown> {
    switch (method) {
      case 'storage.get':
        return context.storage.get(args[0] as string);
      case 'storage.set':
        return context.storage.set(args[0] as string, args[1]);
      case 'storage.delete':
        return context.storage.delete(args[0] as string);
      case 'storage.keys':
        return context.storage.keys();
      case 'storage.clear':
        return context.storage.clear();
      case 'ai.categorize':
        return this.requireAI(context).categorize(args[0] as never);
      case 'ai.generateReplySuggestions':
        return this.requireAI(context).generateReplySuggestions(args[0] as never);
      case 'ai.summarize':
        return this.requireAI(context).summarize(args[0] as string);
      case 'ai.extractActionItems':
        return this.requireAI(context).extractActionItems(args[0] as never);
      case 'ai.complete':
        return this.requireAI(context).complete(args[0] as never);
      case 'settings.update':
        return context.settings.update(args[0] as string, args[1]);
      case 'mail.get':
        return context.mail.get(args[0] as string);
      case 'mail.folders':
        return context.mail.folders(args[0] as string | undefined);
      case 'mail.applyLabels':
        return this.applyLabels(context, args as [string, { add?: string[]; remove?: string[] }]);
      case 'mail.move':
        return context.mail.move(args[0] as string, args[1] as string);
      case 'mail.trash':
        return context.mail.trash(args[0] as string);
      case 'ui.notify':
        context.ui.notify(args[0] as ExtensionUINotification);
        return undefined;
      case 'ui.dismiss':
        context.ui.dismiss(args[0] as string);
        return undefined;
      case 'ui.openPanel':
        context.ui.openPanel(args[0] as string);
        return undefined;
      case 'ui.openMessage':
        context.ui.openMessage(args[0] as string, args[1] as string | undefined);
        return undefined;
      case 'events.subscribe':
        return this.subscribe(context, extensionId, args as [string, string, boolean]);
      case 'events.unsubscribe':
        return this.unsubscribe(extensionId, args[0] as string);
      case 'events.emit':
        context.events.emit(args[0] as PipelineEvent);
        return undefined;
      case 'workflow.register':
        this.hooks.onWorkflowRegistered(extensionId, args[0] as WorkflowDescriptor);
        return undefined;
      case 'workflow.unregister':
        this.hooks.onWorkflowUnregistered(extensionId, args[0] as string);
        return undefined;
      default:
        throw new Error(`Unknown host call '${method as string}'`);
    }
  }

  /**
   * Re-run a sandbox label change through the real, permission-checked API.
   *
   * The sandbox sends one flat change set, but a change set is not one
   * permission: `read` and `starred` need `email:flag` while everything else
   * needs `email:label`. Routing each tag back to the method that owns it is
   * what keeps the check in main honest — nothing here reads the sandbox's
   * copy of the granted set, and a sandbox that asked for a label it may not
   * apply is refused on that tag alone rather than on the whole call.
   */
  private async applyLabels(
    context: ExtensionContextImpl,
    args: [string, { add?: string[]; remove?: string[] }]
  ): Promise<void> {
    const [emailId, changes] = args;
    if (typeof emailId !== 'string' || !emailId) throw new Error('mail: an email id is required');

    for (const tag of changes?.add ?? []) {
      if (tag === 'read') await context.mail.markRead(emailId);
      else if (tag === 'starred') await context.mail.star(emailId);
      else await context.mail.addLabel(emailId, tag);
    }
    for (const tag of changes?.remove ?? []) {
      if (tag === 'read') await context.mail.markUnread(emailId);
      else if (tag === 'starred') await context.mail.unstar(emailId);
      else await context.mail.removeLabel(emailId, tag);
    }
  }

  /**
   * `context.ai` is absent unless `ai:use` was granted, and an absent AI has to
   * fail as a permission error rather than a TypeError on `undefined`.
   */
  private requireAI(context: ExtensionContextImpl) {
    if (!context.ai) {
      throw new Error(
        "Permission denied: Extension requires 'ai:use' permission for operation 'ai'"
      );
    }
    return context.ai;
  }

  private subscribe(
    context: ExtensionContextImpl,
    extensionId: string,
    [eventType, subscriptionId, once]: [string, string, boolean]
  ): void {
    const forward = (event: PipelineEvent) => {
      // Deliberately not awaited by the bus: an extension handler must not be
      // able to hold up the pipeline that published the event. Failures are
      // logged against the extension instead of rejecting into the emitter.
      void this.invoke(extensionId, 'event.dispatch', [subscriptionId, event, once]).catch(
        (error: Error) =>
          logger.warn(`[Extension:${extensionId}] handler for ${eventType} failed: ${error.message}`)
      );
    };

    if (once) {
      // `once` needs no disposer entry: the bus drops it after one delivery,
      // and the context already tracks the unsubscribe for the never-fired case.
      context.events.once(eventType as PipelineEvent['type'], forward);
      return;
    }

    const unsubscribe = context.events.on(eventType as PipelineEvent['type'], forward);
    let forExtension = this.subscriptions.get(extensionId);
    if (!forExtension) {
      forExtension = new Map();
      this.subscriptions.set(extensionId, forExtension);
    }
    forExtension.set(subscriptionId, unsubscribe);
  }

  private unsubscribe(extensionId: string, subscriptionId: string): void {
    const forExtension = this.subscriptions.get(extensionId);
    const dispose = forExtension?.get(subscriptionId);
    if (!dispose) return;
    forExtension?.delete(subscriptionId);
    dispose();
  }

  private detachSubscriptions(extensionId: string): void {
    const forExtension = this.subscriptions.get(extensionId);
    if (!forExtension) return;
    for (const dispose of forExtension.values()) {
      try {
        dispose();
      } catch {
        // One bad disposer must not strand the others.
      }
    }
    this.subscriptions.delete(extensionId);
  }

  /**
   * The sandbox is gone.
   *
   * Every in-flight call has to reject now. Left pending they would hang the
   * ingest pipeline on a process that is never going to answer — the failure
   * mode this whole boundary exists to prevent.
   */
  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error('Extension sandbox stopped');
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.reject(error);
    }
    for (const extensionId of Array.from(this.subscriptions.keys())) {
      this.detachSubscriptions(extensionId);
    }
    // Unblocks anything awaiting `whenReady()` on a sandbox that died during
    // startup; the activate that follows fails fast on `closed`.
    this.markReady();
    this.hooks.onSandboxClosed();
  }
}
