/**
 * The wire protocol between the main process and the extension sandbox.
 *
 * Extension code does not run in the main process. It runs in a separate
 * sandbox — one shared process for every extension, not one each — and reaches
 * the app only through the messages defined here. That boundary is the whole
 * point: an extension that throws, spins, or leaks takes its own process with
 * it and leaves mail sync, IMAP connections and the window untouched.
 *
 * Two rules hold the design together:
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
 */

import type { PipelineEvent } from '../../pipeline/types';
import type { EmailRecord } from '../../types/models';
import type {
  ExtensionManifest,
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
  | 'ui.notify'
  | 'ui.dismiss'
  | 'ui.openPanel'
  | 'ui.openMessage'
  | 'events.subscribe'
  | 'events.unsubscribe'
  | 'events.emit'
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

/** Everything the sandbox needs to bring one extension up. */
export interface SandboxActivationRequest {
  extensionId: string;
  manifest: ExtensionManifest;
  entryPoint: string;
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
    };

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
 * the same sandbox engine has to run over a `utilityProcess` in the app and
 * over an in-memory pair in the tests, and neither should know which it got.
 */
export interface ExtensionChannel {
  post(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}
