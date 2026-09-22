/**
 * Main-process stand-ins for things that now live in the sandbox.
 *
 * An extension's workflows and exports are objects in another process. These
 * build local objects with the same shape, backed by the bridge, so the rest of
 * the app — the workflow adapter, the IPC handlers that call an extension's
 * exported functions — keeps talking to plain objects and never learns that a
 * process boundary moved underneath it.
 */

import type { WorkflowResult } from '../../pipeline/types';
import type { EmailRecord } from '../../types/models';
import type {
  ExtensionWorkflow,
  ExtensionWorkflowResult,
  WorkflowExecutionContext,
} from '../types';

import type { ExtensionBridge } from './extension-bridge';
import {
  deserializeError,
  serializeError,
  type SerializedWorkflowResult,
  type WorkflowDescriptor,
} from './protocol';

/** Strip the `Error` out of a result so it can cross a process boundary. */
export function serializeWorkflowResult(result: WorkflowResult): SerializedWorkflowResult {
  const { error, ...rest } = result;
  return { ...rest, ...(error ? { error: serializeError(error) } : {}) };
}

/** Put it back, so `result.error instanceof Error` still holds in main. */
export function deserializeWorkflowResult(
  result: SerializedWorkflowResult
): ExtensionWorkflowResult {
  const { error, ...rest } = result;
  return {
    ...(rest as Omit<ExtensionWorkflowResult, 'error'>),
    ...(error ? { error: deserializeError(error) } : {}),
  } as ExtensionWorkflowResult;
}

/**
 * An `ExtensionWorkflow` whose two methods are round trips.
 *
 * The execution context it is handed cannot travel — it carries an `ai` object,
 * a logger and an `AbortSignal`, none of them cloneable — so only the two parts
 * the sandbox cannot reconstruct on its own are sent: the results of earlier
 * workflows, and the abort. The sandbox rebuilds the rest around its own
 * context, which is why an extension sees the same `WorkflowExecutionContext`
 * it always did.
 */
export function createRemoteWorkflow(
  bridge: ExtensionBridge,
  extensionId: string,
  descriptor: WorkflowDescriptor
): ExtensionWorkflow {
  return {
    id: descriptor.id,
    name: descriptor.name,
    description: descriptor.description,
    priority: descriptor.priority,
    requiresAI: descriptor.requiresAI,
    requiresBody: descriptor.requiresBody,
    runInBackground: descriptor.runInBackground,
    enabled: descriptor.enabled,

    shouldProcess: (email: EmailRecord): Promise<boolean> =>
      bridge.invoke<boolean>(extensionId, 'workflow.shouldProcess', [
        descriptor.fullId,
        email,
      ]),

    process: async (
      email: EmailRecord,
      context: WorkflowExecutionContext
    ): Promise<ExtensionWorkflowResult> => {
      const previousResults = Array.from(context.previousResults?.entries() ?? []).map(
        ([id, result]) => [id, serializeWorkflowResult(result)] as [string, SerializedWorkflowResult]
      );
      const result = await bridge.invoke<SerializedWorkflowResult>(
        extensionId,
        'workflow.process',
        [{ fullId: descriptor.fullId, email, previousResults }],
        context.abortSignal
      );
      return deserializeWorkflowResult(result);
    },
  };
}

/**
 * Local functions standing in for the extension's exported ones.
 *
 * Callers test `typeof exports.foo === 'function'` and then `await` it, which a
 * function that returns a promise satisfies exactly. Only the names the sandbox
 * reported are present, so a missing export is still `undefined` here rather
 * than a function that fails on call.
 */
export function createRemoteExports(
  bridge: ExtensionBridge,
  extensionId: string,
  exportNames: string[]
): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  for (const name of exportNames) {
    exports[name] = (...args: unknown[]): Promise<unknown> =>
      bridge.invoke<unknown>(extensionId, 'export.call', [name, args]);
  }
  return exports;
}
