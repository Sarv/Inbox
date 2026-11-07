/**
 * The wire protocol between the main process and the extension sandbox.
 *
 * Extension code does not run in the main process. Each extension runs in a
 * sandbox of its own and reaches the app only through the messages defined
 * here. That boundary is the whole point: an extension that throws, spins, or
 * leaks takes its own sandbox with it and leaves mail sync, IMAP connections,
 * the window and every other extension untouched.
 *
 * Three rules hold the design together:
 *
 *  1. **Permission checks live in main, always.** The sandbox mirrors the
 *     granted set so an authoring mistake fails fast and synchronously where it
 *     was written, but that copy is a convenience. Every `host-call` is
 *     re-checked against the real `ExtensionContextImpl` before it touches a
 *     backend, so a sandbox that lies about its permissions gains nothing.
 *  2. **Everything crossing the boundary is structured-clone safe.** No
 *     functions, no class instances, no `Error` objects — errors travel as
 *     `SerializedError` and are rebuilt on arrival, so a stack survives the
 *     trip and `instanceof Error` still holds where extensions catch it.
 *  3. **Nothing a sandbox sends is believed about who sent it.** The engine on
 *     the far side shares a thread with the extension, which can post anything
 *     it likes on that port. So main binds one channel to one extension and
 *     reads the sender from the channel. The `extensionId` fields below only
 *     route inside the sandbox.
 */

import type { PipelineEvent } from '../../pipeline/types';
import type { EmailRecord } from '../../types/models';
import type {
  ExtensionManifest,
  ExtensionNetworkResponse,
  ExtensionNetworkResult,
  ExtensionPermission,
  ExtensionWorkflowResult,
} from '../types';

/** An `Error` flattened for transport, and rebuildable on the far side. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/** Flatten anything thrown into something that survives structured clone. */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: 'Error', message: String(error) };
}

/** Rebuild a real `Error` so callers can `catch (e) { e.message }` as usual. */
export function deserializeError(serialized: SerializedError): Error {
  const error = new Error(serialized.message);
  error.name = serialized.name;
  // The sandbox's stack is more useful than the one manufactured here, which
  // would only ever point at this function.
  if (serialized.stack) error.stack = serialized.stack;
  return error;
}

/**
 * Put the reading methods back on a network result.
 *
 * Main answers with plain data, because that is what crosses the boundary. The
 * body has already arrived whole, so these are ordinary calls, named as `fetch`
 * names them so an extension moving off `fetch` changes as little as it can.
 */
export function networkResponseFrom(result: ExtensionNetworkResult): ExtensionNetworkResponse {
  const { body, ...rest } = result;
  const text = (): string => new TextDecoder().decode(body);
  return {
    ...rest,
    bytes: () => body,
    text,
    json: <T,>(): T => JSON.parse(text()) as T,
  };
}

/**
 * A workflow result with its `Error` flattened.
 *
 * `WorkflowResult.error` is the one non-cloneable field on the happy path, and
 * dropping it would turn "the workflow failed because the API key is missing"
 * into a silent `success: false` with nothing to show the user.
 */
export interface SerializedWorkflowResult extends Omit<ExtensionWorkflowResult, 'error'> {
  error?: SerializedError;
}

/** What the sandbox reports about a workflow the extension registered. */
export interface WorkflowDescriptor {
  /** `<extension-id>.<workflow-id>` — the id the pipeline knows it by. */
  fullId: string;
  id: string;
  name: string;
  description?: string;
  priority?: number;
  requiresAI?: boolean;
  requiresBody?: boolean;
  runInBackground?: boolean;
  enabled?: boolean;
}

/**
 * The host APIs an extension can reach, as flat method names.
 *
 * Kept as a string union rather than free-form so an unknown method is a
 * protocol error the bridge rejects, not a lookup that quietly resolves to
 * `undefined` and returns success.
 */
export type HostCallMethod =
  | 'storage.get'
  | 'storage.set'
  | 'storage.delete'
  | 'storage.keys'
  | 'storage.clear'
  | 'ai.categorize'
  | 'ai.generateReplySuggestions'
  | 'ai.summarize'
  | 'ai.extractActionItems'
  | 'ai.complete'
  | 'settings.update'
  | 'mail.get'
  | 'mail.folders'
  | 'mail.applyLabels'
  | 'mail.move'
  | 'mail.trash'
  | 'network.fetch'
  | 'security.getTargets'
  | 'security.getSetup'
  | 'security.openSetup'
  | 'security.submit'
  | 'security.get'
  | 'security.cancel'
  | 'ui.notify'
  | 'ui.dismiss'
  | 'ui.openPanel'
  | 'ui.openMessage'
  | 'events.subscribe'
  | 'events.unsubscribe'
  | 'workflow.register'
  | 'workflow.unregister';

/** What the sandbox can be asked to run. */
export type SandboxInvokeTarget =
  | 'workflow.shouldProcess'
  | 'workflow.process'
  | 'export.call'
  | 'event.dispatch'
  /** The reader copied, dismissed or opened one of this extension's cards. */
  | 'ui.action';

/**
 * The state the sandbox has to answer synchronously.
 *
 * Three API members return a value rather than a promise — `ai.isAvailable()`,
 * `settings.get()` and `settings.has()` — and an extension is written expecting
 * that. They cannot become round trips without breaking every extension already
 * published, so the values are mirrored into the sandbox at activation and
 * pushed again whenever they change.
 */
export interface SandboxSyncState {
  aiAvailable: boolean;
  /** The extension's own settings, by bare key. */
  settings: Record<string, unknown>;
}

/**
 * Which extension a sandbox is being started for.
 *
 * One sandbox runs one extension, so the channel factory is told which. Paths
 * here are real and stay on the host's side of the boundary: nothing absolute
 * is sent into the sandbox (see `SandboxActivationRequest`).
 */
export interface SandboxTarget {
  extensionId: string;
  /** Absolute path of the extension's installed folder. */
  rootDir: string;
  /** Absolute path of the module to load, inside `rootDir`. */
  entryPoint: string;
}

/** Everything the sandbox needs to bring one extension up. */
export interface SandboxActivationRequest {
  extensionId: string;
  manifest: ExtensionManifest;
  /**
   * The module to load, relative to the extension's folder with `/` separators
   * on every platform. Relative because an absolute path would tell confined
   * code where the user's home directory is.
   */
  entryPoint: string;
  /**
   * What `context.storagePath` reads. Not a real directory: confined code has
   * no filesystem to use it with, and the real one would name the user's home.
   */
  storagePath: string;
  grantedPermissions: ExtensionPermission[];
  state: SandboxSyncState;
}

/** Messages the main process sends into the sandbox. */
export type HostToSandboxMessage =
  | { type: 'activate'; requestId: string; request: SandboxActivationRequest }
  | { type: 'deactivate'; requestId: string; extensionId: string }
  | {
      type: 'invoke';
      requestId: string;
      extensionId: string;
      target: SandboxInvokeTarget;
      args: unknown[];
    }
  /** Cancel an in-flight `invoke`; the sandbox aborts that call's signal. */
  | { type: 'abort'; requestId: string }
  /** The answer to a `host-call` the sandbox made. */
  | { type: 'host-reply'; requestId: string; ok: boolean; value?: unknown; error?: SerializedError }
  /** A push refreshing the values the sandbox has to answer synchronously. */
  | { type: 'sync-state'; extensionId: string; state: Partial<SandboxSyncState> }
  /** Are you still running? Answered with `pong` from the sandbox's own event loop. */
  | { type: 'ping'; nonce: number }
  | { type: 'shutdown' };

/** Messages the sandbox sends back to the main process. */
export type SandboxToHostMessage =
  | { type: 'ready' }
  | {
      type: 'activated';
      requestId: string;
      extensionId: string;
      workflows: WorkflowDescriptor[];
      /** Names on `context.exports`, so main can build a calling proxy. */
      exportNames: string[];
    }
  | { type: 'deactivated'; requestId: string; extensionId: string }
  /** An `activate`/`deactivate`/`invoke` that failed. */
  | { type: 'failed'; requestId: string; error: SerializedError }
  | { type: 'invoke-reply'; requestId: string; ok: boolean; value?: unknown; error?: SerializedError }
  | {
      type: 'host-call';
      requestId: string;
      extensionId: string;
      method: HostCallMethod;
      args: unknown[];
    }
  | {
      type: 'log';
      extensionId: string;
      level: 'debug' | 'info' | 'warn' | 'error';
      message: string;
    }
  /** The answer to `ping`, echoing its nonce. */
  | { type: 'pong'; nonce: number }
  /**
   * The extension failed because it used a Node API the sandbox does not have.
   * Main tells the user: an extension written for the old full-Node runtime
   * must not simply stop doing anything.
   */
  | { type: 'unsupported-api'; extensionId: string; api: string };

/** The pipeline event handed to a sandbox subscription. */
export interface DispatchedEvent {
  subscriptionId: string;
  event: PipelineEvent;
}

/** Arguments for `workflow.process`, with the un-cloneable parts replaced. */
export interface SerializedWorkflowCall {
  fullId: string;
  email: EmailRecord;
  /** `previousResults` as entries — a `Map` does clone, an `Error` inside does not. */
  previousResults: [string, SerializedWorkflowResult][];
}

/**
 * A duplex message channel, in the smallest shape both ends need.
 *
 * Deliberately not Electron's `MessagePort` or Node's `worker_threads` port:
 * the same sandbox engine has to run over a Web Worker's port in the app and
 * over an in-memory pair in the tests, and neither should know which it got.
 */
export interface ExtensionChannel {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  /**
   * Called once, when the other end is gone. `reason`, when the transport knows
   * one, is said to the user as is: "stopped responding and was stopped". `details`
   * says whether it is worth starting the extension again.
   */
  onClose(handler: (reason?: string, details?: SandboxCloseDetails) => void): void;
  /** Close it. A transport with something to tear down resolves once that is done. */
  close(): void | Promise<void>;
  /**
   * End it now, whatever it is doing, for a reason the user is told. Left out by a
   * transport with nothing to kill, such as an in-memory pair.
   */
  kill?(reason: string): void;
}

/** How a sandbox ended, for deciding what happens next. */
export interface SandboxCloseDetails {
  /**
   * It crashed, or the operating system took it away, and may well run if started again.
   * False when it was stopped on purpose: a hang, a flood, a broken rule.
   */
  transient: boolean;
}
