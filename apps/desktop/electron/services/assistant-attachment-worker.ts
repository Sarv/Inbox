import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { resolveUnpacked } from '@sarvinbox/core';

import {
  ASSISTANT_ATTACHMENT_LIMITS as LIMIT,
  assistantAttachmentFailure,
  type AssistantAttachmentExtraction,
} from './assistant-attachment-types';

let activeWorkers = 0;

export function assistantAttachmentWorkerPath(): string {
  return resolveUnpacked(join(__dirname, 'assistant-attachment-extract.worker.js'));
}

/** Untrusted documents run outside main, with a deadline and a bounded V8 heap. */
export async function runAssistantAttachmentWorker(
  filename: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<AssistantAttachmentExtraction> {
  if (signal?.aborted) return assistantAttachmentFailure('cancelled');
  if (bytes.byteLength > LIMIT.bytes) return assistantAttachmentFailure('too_large');
  if (activeWorkers >= 2) return assistantAttachmentFailure('unavailable', 'Other attachments are being read. Try again shortly.');
  activeWorkers++;
  try {
    return await new Promise(resolve => {
      const privateBytes = Uint8Array.from(bytes);
      let worker: Worker;
      try {
        worker = new Worker(assistantAttachmentWorkerPath(), {
          workerData: { filename, bytes: privateBytes },
          transferList: [privateBytes.buffer],
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        });
      } catch {
        if (privateBytes.byteLength) privateBytes.fill(0);
        resolve(assistantAttachmentFailure('unavailable', 'Attachment reader could not start.'));
        return;
      }
      let settled = false;
      const finish = (result: AssistantAttachmentExtraction) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void worker.terminate();
        resolve(result);
      };
      const abort = () => finish(assistantAttachmentFailure('cancelled'));
      const timer = setTimeout(() => finish(assistantAttachmentFailure('timeout', 'Attachment reading exceeded the time limit.')), LIMIT.timeoutMs);
      timer.unref?.();
      worker.once('message', (result: AssistantAttachmentExtraction) => finish(result));
      worker.once('error', () => finish(assistantAttachmentFailure('malformed', 'Attachment text could not be read.')));
      worker.once('exit', () => finish(assistantAttachmentFailure('unavailable', 'Attachment reader stopped before finishing.')));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally { activeWorkers--; }
}
