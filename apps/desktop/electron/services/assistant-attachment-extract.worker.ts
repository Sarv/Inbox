import { parentPort, workerData } from 'node:worker_threads';

import { extractAssistantAttachment } from './assistant-attachment-extractor';
import { assistantAttachmentFailure } from './assistant-attachment-types';

async function run(): Promise<void> {
  const input = workerData as { filename?: unknown; bytes?: unknown };
  if (typeof input?.filename !== 'string' || !(input.bytes instanceof Uint8Array)) {
    parentPort?.postMessage(assistantAttachmentFailure('malformed'));
    return;
  }
  try {
    parentPort?.postMessage(await extractAssistantAttachment({ filename: input.filename, bytes: input.bytes }));
  } finally { input.bytes.fill(0); }
}

void run().catch(() => { parentPort?.postMessage(assistantAttachmentFailure('malformed')); });
