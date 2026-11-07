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
 * `ExtensionChannel` and never learns whether the other end is a confined Web
 * Worker or an in-memory pair, which is what lets the tests drive the real
 * engine instead of a stand-in.
 *
 * One bridge serves one extension, and that is what makes it a boundary. The
 * extension shares a thread with the engine on the far side, so it can post
 * anything on its port: a reply to a call it was never asked, or a host call in
 * another extension's name. Its pending calls are its own, and the extension a
 * host call is checked against comes from this object, never from the message.
 */

import type { PipelineEvent } from '../../pipeline/types';
import { createLogger } from '../../utils/logger';
import { withTimeout } from '../../utils/timeout';
import type { ExtensionContextImpl } from '../extension-api';
import type { AntivirusScanSubmitOptions, ExtensionUINotification } from '../types';

import { createFloodBudget, type FloodBudget } from './flood-budget';
import { createLogBudget, MAX_EXTENSION_LOG_LINE, type LogBudget } from './log-budget';
import {
  deserializeError,
  serializeError,
  type ExtensionChannel,
  type HostCallMethod,
  type HostToSandboxMessage,
  type SandboxActivationRequest,
  type SandboxCloseDetails,
  type SandboxInvokeTarget,
  type SandboxSyncState,
  type SandboxToHostMessage,
  type WorkflowDescriptor,
} from './protocol';
import { isKnownNodeApi } from './unsupported-node-api';

/**
 * How long a single call into the sandbox may take before it is abandoned.
 *
 * Generous because a workflow may be waiting on an AI completion, and a false
 * timeout looks exactly like an extension that silently does nothing. The real
 * protection against a wedged sandbox is the crash path — every pending call
 * rejects the moment the channel closes — not this number.
 */
export const DEFAULT_INVOKE_TIMEOUT_MS = 120_000;

/**
 * How long an extension's own `deactivate()` may take.
 *
 * Far shorter than a call that may be waiting on an AI completion, because
 * something is waiting for this one: the user's click on the switch, or the app
 * trying to quit. Its sandbox is closed either way.
 */
export const DEACTIVATE_TIMEOUT_MS = 5_000;

/**
 * How long host calls may run before the main process gets a turn.
 *
 * Measured: an extension calling `storage.set` in a loop froze the main thread for
 * 17 seconds, because the default backend does its file work synchronously and
 * queued port messages run one after another. Sharing the thread out keeps the app
 * responsive while the extension merely waits longer for its answers.
 */
export const HOST_CALL_SLICE_MS = 8;

/** Host calls waiting their turn, beyond which more are refused rather than held. */
export const MAX_QUEUED_HOST_CALLS = 5_000;

/**
 * What one extension may leave behind in main: each of these is kept for as long as it
 * runs, and the extension chooses how many and how long. Measured: without them, workflow
 * registrations carrying 5 MB ids ran main out of memory in 5 seconds. Far more than any
 * real extension wants, and going past one is not a mistake to answer politely, so it
 * stops the extension.
 */
export const MAX_WORKFLOWS_PER_EXTENSION = 64;
/** Across a run, not at once, or registering and dropping in a loop would never end. */
export const MAX_WORKFLOW_REGISTRATIONS = 1_024;
export const MAX_SUBSCRIPTIONS_PER_EXTENSION = 64;
export const MAX_EXPORTS_PER_EXTENSION = 256;
/** An id, an event type or a name: short things that end up in logs and adapters. */
export const MAX_IDENTIFIER_LENGTH = 128;
export const MAX_DESCRIPTION_LENGTH = 1_000;
/** A label, in one change: labels are written into the mail database's tags. */
export const MAX_LABEL_LENGTH = 128;
export const MAX_LABELS_PER_CHANGE = 32;

/** What the user reads when one of those limits stops an extension. */
const OVER_LIMITS_REASON = 'This extension asked for far more than extensions may keep and was stopped.';
const FLOOD_REASON = 'This extension sent far too many messages to the app and was stopped.';
const FLOOD_BYTES_REASON = 'This extension sent far too much data to the app and was stopped.';

const logger = createLogger('extension-bridge');

export interface ExtensionBridgeHooks {
  /** The live, permission-checked context for an extension, if it is active. */
  getContext(extensionId: string): ExtensionContextImpl | undefined;
  /** A workflow registered after activation finished. */
  onWorkflowRegistered(extensionId: string, descriptor: WorkflowDescriptor): void;
  /** A workflow the extension withdrew. */
  onWorkflowUnregistered(extensionId: string, fullId: string): void;
  /** The sandbox went away, so the extension in it is no longer running. */
  onSandboxClosed(reason?: string, details?: SandboxCloseDetails): void;
  /** The extension failed for want of a Node API the sandbox does not have. */
  onUnsupportedApi?(extensionId: string, api: string): void;
}

export interface ExtensionBridgeOptions {
  channel: ExtensionChannel;
  hooks: ExtensionBridgeHooks;
  /** The one extension this channel belongs to. Every message is taken as from it. */
  extensionId: string;
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

/** An id, a name or an event type: a non-empty string of a sensible length. */
function isShortText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH;
}

export class ExtensionBridge {
  private readonly channel: ExtensionChannel;
  private readonly hooks: ExtensionBridgeHooks;
  private readonly extensionId: string;
  private readonly invokeTimeoutMs: number;
  private readonly logBudget: LogBudget = createLogBudget();
  private readonly floodBudget: FloodBudget = createFloodBudget();
  private readonly workflowIds = new Set<string>();
  private workflowRegistrations = 0;

  private readonly pending = new Map<string, PendingCall>();
  /** Live event subscriptions per extension, so deactivation detaches them. */
  private readonly subscriptions = new Map<string, Map<string, () => void>>();
  private nextId = 0;
  private closed = false;
  private closeReason: string | undefined;
  private readonly hostCallQueue: (() => void)[] = [];
  private drainingHostCalls = false;
  /** A refused impersonation is logged once: the sender can repeat it forever. */
  private warnedAboutIdentity = false;
  private readonly ready: Promise<void>;
  private markReady: () => void = () => undefined;

  constructor(options: ExtensionBridgeOptions) {
    this.channel = options.channel;
    this.hooks = options.hooks;
    this.extensionId = options.extensionId;
    this.invokeTimeoutMs = options.invokeTimeoutMs ?? DEFAULT_INVOKE_TIMEOUT_MS;
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });

    this.channel.onMessage((raw) => this.receive(raw as SandboxToHostMessage));
    this.channel.onClose((reason, details) => this.handleClose(reason, details));
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
    await this.awaitReply<void>(
      requestId,
      { type: 'deactivate', requestId, extensionId },
      Math.min(DEACTIVATE_TIMEOUT_MS, this.invokeTimeoutMs)
    );
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
    await this.channel.close();
  }

  /**
   * Stop the sandbox now, for a reason the user is told.
   *
   * For an extension that has broken a rule, or one already known not to answer: there is
   * no point asking it to wind down.
   */
  async terminate(reason: string, details: SandboxCloseDetails = { transient: false }): Promise<void> {
    if (this.closed) return;
    this.handleClose(reason, details);
    if (this.channel.kill) this.channel.kill(reason);
    await this.channel.close();
  }

  private newId(prefix: string): string {
    return `${prefix}-${++this.nextId}`;
  }

  private post(message: HostToSandboxMessage): void {
    if (this.closed) return;
    this.channel.post(message);
  }

  /** Send a request and resolve when its matching reply arrives. */
  private awaitReply<T>(
    requestId: string,
    message: HostToSandboxMessage,
    timeoutMs: number = this.invokeTimeoutMs
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error(this.closeReason ?? 'Extension sandbox is not running'));
    }
    this.floodBudget.noteCall();
    const call = new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.channel.post(message);
    });
    return withTimeout(
      call,
      timeoutMs,
      `Extension sandbox did not answer within ${timeoutMs}ms`
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

  /** Whether this is a reply main is actually waiting for. Nothing else was asked for. */
  private isSolicited(message: SandboxToHostMessage): boolean {
    switch (message?.type) {
      case 'activated':
      case 'deactivated':
      case 'failed':
      case 'invoke-reply':
        return this.pending.has(message.requestId);
      default:
        return false;
    }
  }

  private receive(message: SandboxToHostMessage): void {
    if (this.closed) return;
    const verdict = this.floodBudget.noteMessage(message, this.isSolicited(message));
    if (verdict !== 'ok') {
      void this.terminate(verdict === 'too-large' ? FLOOD_BYTES_REASON : FLOOD_REASON);
      return;
    }

    switch (message?.type) {
      case 'ready':
        this.markReady();
        break;
      case 'activated':
        if (!this.pending.has(message.requestId)) break;
        if (!this.acceptActivation(message.workflows, message.exportNames)) {
          this.breakRule();
          break;
        }
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
        // Refused, not corrected: a sandbox naming someone else is not confused.
        if (message.extensionId !== this.extensionId) {
          this.refuseImpersonation(message.requestId, message.extensionId);
          break;
        }
        this.queueHostCall(message.requestId, message.method, message.args);
        break;
      case 'log':
        this.writeExtensionLog(message.level, message.message);
        break;
      case 'unsupported-api':
        if (isKnownNodeApi(message.api)) this.hooks.onUnsupportedApi?.(this.extensionId, message.api);
        break;
      default:
        break;
    }
  }

  /** The extension went past something it was told it may keep. Not its to argue. */
  private breakRule(): void {
    logger.warn(`[Extension:${this.extensionId}] went over a limit on what an extension may keep`);
    void this.terminate(OVER_LIMITS_REASON);
  }

  /** Whether a workflow's description is the shape and size main is willing to hold. */
  private isAcceptableWorkflow(descriptor: unknown): descriptor is WorkflowDescriptor {
    if (!descriptor || typeof descriptor !== 'object') return false;
    const { id, name, description, fullId } = descriptor as Record<string, unknown>;
    return (
      isShortText(id) &&
      isShortText(name) &&
      fullId === `${this.extensionId}.${id}` &&
      (description === undefined ||
        (typeof description === 'string' && description.length <= MAX_DESCRIPTION_LENGTH))
    );
  }

  /** The first report of what the extension registered, checked before main adopts any. */
  private acceptActivation(workflows: unknown, exportNames: unknown): boolean {
    if (!Array.isArray(workflows) || !Array.isArray(exportNames)) return false;
    if (workflows.length > MAX_WORKFLOWS_PER_EXTENSION) return false;
    if (exportNames.length > MAX_EXPORTS_PER_EXTENSION) return false;
    if (!exportNames.every(isShortText)) return false;
    if (!workflows.every((workflow) => this.isAcceptableWorkflow(workflow))) return false;
    for (const workflow of workflows as WorkflowDescriptor[]) this.workflowIds.add(workflow.fullId);
    this.workflowRegistrations += workflows.length;
    return true;
  }

  /**
   * Host calls run in the order they came, a slice at a time. Each is only started
   * here, so a backend doing real asynchronous work still overlaps with the next.
   */
  private queueHostCall(requestId: string, method: HostCallMethod, args: unknown[]): void {
    if (this.hostCallQueue.length >= MAX_QUEUED_HOST_CALLS) {
      this.post({
        type: 'host-reply',
        requestId,
        ok: false,
        error: { name: 'Error', message: 'Too many calls at once: wait for some to finish' },
      });
      return;
    }
    this.hostCallQueue.push(() => {
      void this.serveHostCall(requestId, this.extensionId, method, args);
    });
    if (!this.drainingHostCalls) void this.drainHostCalls();
  }

  private async drainHostCalls(): Promise<void> {
    this.drainingHostCalls = true;
    let sliceStart = Date.now();
    while (this.hostCallQueue.length > 0 && !this.closed) {
      this.hostCallQueue.shift()?.();
      if (Date.now() - sliceStart >= HOST_CALL_SLICE_MS) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        sliceStart = Date.now();
      }
    }
    this.hostCallQueue.length = 0;
    this.drainingHostCalls = false;
  }

  private refuseImpersonation(requestId: string, claimed: unknown): void {
    if (!this.warnedAboutIdentity) {
      this.warnedAboutIdentity = true;
      logger.warn(
        `[Extension:${this.extensionId}] refused a call made in the name of ${String(claimed).slice(0, 100)}`
      );
    }
    this.post({
      type: 'host-reply',
      requestId,
      ok: false,
      error: { name: 'Error', message: 'A sandbox can only call for its own extension' },
    });
  }

  /**
   * Extension logs are re-emitted through the app's logger, tagged with the
   * extension they came from, so `app.log` carries one stream rather than two
   * and a misbehaving extension is attributable.
   *
   * Budgeted and capped: each line is a synchronous write on the main thread,
   * and a loop in an extension must not be able to spend main's time.
   */
  private writeExtensionLog(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    const verdict = this.logBudget.take();
    if (verdict.dropped > 0) {
      logger.warn(`[Extension:${this.extensionId}] ${verdict.dropped} log lines dropped: too many`);
    }
    if (!verdict.allowed) return;
    const line = `[Extension:${this.extensionId}] ${String(message).slice(0, MAX_EXTENSION_LOG_LINE)}`;
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
      // No stack: its paths would name where the app is installed, and on most
      // machines the user's home directory, to code that has no other way to learn it.
      const { name, message } = serializeError(error);
      this.post({ type: 'host-reply', requestId, ok: false, error: { name, message } });
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
      case 'security.getTargets':
        return context.security.getTargets();
      case 'security.getSetup':
        return context.security.getSetup();
      case 'security.openSetup':
        return context.security.openSetup();
      case 'security.submit':
        return context.security.submit(args[0] as string[], args[1] as AntivirusScanSubmitOptions | undefined);
      case 'security.get':
        return context.security.get(args[0] as string);
      case 'security.cancel':
        return context.security.cancel(args[0] as string);
      case 'mail.folders':
        return context.mail.folders(args[0] as string | undefined);
      case 'mail.applyLabels':
        return this.applyLabels(context, args as [string, { add?: string[]; remove?: string[] }]);
      case 'mail.move':
        return context.mail.move(args[0] as string, args[1] as string);
      case 'mail.trash':
        return context.mail.trash(args[0] as string);
      case 'network.fetch':
        // The plain-data form: the reading methods are put back on the far side.
        return context.fetchForExtension(args[0], args[1]);
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
      case 'workflow.register': {
        const descriptor = args[0] as WorkflowDescriptor;
        this.requireOwnWorkflowId(descriptor?.fullId);
        this.workflowRegistrations += 1;
        if (
          !this.isAcceptableWorkflow(descriptor) ||
          this.workflowRegistrations > MAX_WORKFLOW_REGISTRATIONS ||
          (!this.workflowIds.has(descriptor.fullId) &&
            this.workflowIds.size >= MAX_WORKFLOWS_PER_EXTENSION)
        ) {
          this.breakRule();
          throw new Error(OVER_LIMITS_REASON);
        }
        this.workflowIds.add(descriptor.fullId);
        this.hooks.onWorkflowRegistered(extensionId, descriptor);
        return undefined;
      }
      case 'workflow.unregister':
        this.requireOwnWorkflowId(args[0]);
        this.workflowIds.delete(args[0] as string);
        this.hooks.onWorkflowUnregistered(extensionId, args[0] as string);
        return undefined;
      default:
        throw new Error(`Unknown host call '${method as string}'`);
    }
  }

  /**
   * A workflow id names its extension, and adapters are keyed by that name. Taken
   * on trust, it would let one extension retire or replace another's workflow.
   */
  private requireOwnWorkflowId(fullId: unknown): void {
    if (typeof fullId !== 'string' || !fullId.startsWith(`${this.extensionId}.`)) {
      throw new Error(`A workflow id must start with '${this.extensionId}.'`);
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
    const tags = [...(changes?.add ?? []), ...(changes?.remove ?? [])];
    if (tags.length > MAX_LABELS_PER_CHANGE) throw new Error('mail: too many labels in one change');
    if (tags.some((tag) => typeof tag !== 'string' || tag.length > MAX_LABEL_LENGTH)) {
      throw new Error(`mail: a label may be at most ${MAX_LABEL_LENGTH} characters`);
    }

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
    if (
      !isShortText(eventType) ||
      !isShortText(subscriptionId) ||
      context.subscriptions.length >= MAX_SUBSCRIPTIONS_PER_EXTENSION
    ) {
      this.breakRule();
      throw new Error(OVER_LIMITS_REASON);
    }
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
  private handleClose(reason?: string, details?: SandboxCloseDetails): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    const error = new Error(reason ?? 'Extension sandbox stopped');
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
    this.hooks.onSandboxClosed(reason, details);
  }
}
