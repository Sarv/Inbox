import { randomUUID } from 'node:crypto';

import type { InboxAssistantProgress } from '../../src/types/inbox-assistant';

import {
  ASSISTANT_ATTACHMENT_LIMITS as LIMIT,
  assistantAttachmentFailure,
  type AssistantAttachmentExtraction,
  type AssistantAttachmentRef,
  type AssistantAttachmentResult,
} from './assistant-attachment-types';
import type { AttachmentOperationProtection } from './attachment-download-protection';

export interface AssistantOwnedAttachment {
  /** Revalidate both registry membership and the same owned message before exposing evidence. */
  assertCurrent(): Promise<void>;
  /** Connect/repair metadata before a configured scanner downloads the file. */
  prepare?(signal: AbortSignal): Promise<void>;
  size?: number;
  read(signal: AbortSignal): Promise<Buffer>;
}

export interface AssistantAttachmentReaderDependencies {
  resolve(ref: AssistantAttachmentRef): Promise<AssistantOwnedAttachment | null>;
  operations(): AttachmentOperationProtection | undefined;
  /** Fail closed for a scanner that needs setup, without opening a dialog for every search hit. */
  scannerReady(ref: AssistantAttachmentRef): Promise<boolean>;
  extract(filename: string, bytes: Uint8Array, signal?: AbortSignal): Promise<AssistantAttachmentExtraction>;
}

export interface AssistantAttachmentReadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: InboxAssistantProgress) => void;
  /** A deliberate read of this file may show the existing host security warning. Never enabled for automatic background reads. */
  allowSecurityPrompt?: boolean;
  /** Host-only activity accounting; a human approval wait is not active downloading. */
  onApprovalWait?: (waiting: boolean) => void;
}

const SUPPORTED = /\.(?:pdf|docx|xlsx|pptx|txt|csv|tsv)$/i;

export class AssistantAttachmentReader {
  constructor(private deps: AssistantAttachmentReaderDependencies) {}

  async read(ref: AssistantAttachmentRef, options: AssistantAttachmentReadOptions = {}): Promise<AssistantAttachmentResult> {
    const result = (extraction: AssistantAttachmentExtraction): AssistantAttachmentResult => ({ ref, ...extraction });
    const fail = (status: AssistantAttachmentExtraction['status'], message?: string) => result(assistantAttachmentFailure(status, message));
    const progress = (message: string, detail?: string) => {
      if (!options.signal?.aborted) options.onProgress?.({ stage: 'attachment', status: 'running', message, detail,
        accountId: ref.accountId, emailId: ref.emailId, filename: ref.filename });
    };
    if (!ref || typeof ref.accountId !== 'string' || !ref.accountId || typeof ref.emailId !== 'string' || !ref.emailId ||
      typeof ref.filename !== 'string' || !ref.filename || ref.filename.length > 1024)
      return fail('missing', 'The attachment reference is invalid.');
    if (options.signal?.aborted) return fail('cancelled');
    if (!SUPPORTED.test(ref.filename)) return fail('unsupported', 'This attachment type is not supported for text extraction.');
    let owned: AssistantOwnedAttachment | null;
    try { owned = await this.deps.resolve(ref); }
    catch { return fail('unavailable', 'The attachment account is unavailable.'); }
    if (!owned) return fail('missing', 'Attachment was not found on this message.');
    if (owned.size !== undefined && owned.size > LIMIT.bytes) return fail('too_large', 'Attachment exceeds the 10 MB extraction limit.');
    const operations = this.deps.operations();
    // The attachment gate must be installed even when no scanner is enabled.
    if (!operations) return fail('blocked', 'Attachment security is not ready.');
    const requestId = randomUUID();
    const cancel = () => { try { operations.cancel(requestId); } catch {} };
    try {
      progress(`Checking attachment security for ${ref.filename}`);
      const scannerReady = await this.deps.scannerReady(ref);
      if (!scannerReady && options.allowSecurityPrompt !== true) return fail('blocked', 'Attachment scanning needs attention in Extensions.');
      options.signal?.throwIfAborted();
      if (owned.prepare) {
        progress(`Connecting to the mailbox for ${ref.filename}`);
        await owned.prepare(options.signal ?? new AbortController().signal);
        options.signal?.throwIfAborted();
      }
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (!scannerReady) progress('Waiting for attachment security approval', ref.filename);
      return await operations.run(ref.emailId, ref.accountId, ref.filename, async operation => {
        if (operation.notScanned && options.allowSecurityPrompt !== true) return fail('blocked', 'Attachment scanning needs attention in Extensions.');
        let unscanned: Buffer | undefined;
        try {
          options.signal?.throwIfAborted();
          await owned!.assertCurrent();
          progress(operation.content ? `Reading scanned attachment ${ref.filename}` : `Downloading attachment ${ref.filename}`);
          const bytes = operation.content?.content ?? (unscanned = await owned!.read(operation.signal));
          if (bytes.byteLength > LIMIT.bytes) return fail('too_large', 'Attachment exceeds the 10 MB extraction limit.');
          await operation.assertCurrent();
          await owned!.assertCurrent();
          progress(`Extracting text from ${ref.filename}`, `${Math.max(1, Math.round(bytes.byteLength / 1024))} KB downloaded`);
          const extracted = await this.deps.extract(ref.filename, bytes, operation.signal);
          await operation.assertCurrent();
          await owned!.assertCurrent();
          return result(operation.notScanned ? { ...extracted,
            message: `Read with your permission without antivirus scanning.${extracted.message ? ` ${extracted.message}` : ''}`,
          } : extracted);
        } finally {
          unscanned?.fill(0);
        }
      }, requestId, undefined, 'view', { allowSecurityPrompt: options.allowSecurityPrompt === true, onApprovalWait: options.onApprovalWait });
    } catch {
      if (options.signal?.aborted) return fail('cancelled', 'Attachment reading was cancelled.');
      return fail('blocked', 'Attachment could not be read through the security checks.');
    } finally { options.signal?.removeEventListener('abort', cancel); }
  }
}

let hostReader: AssistantAttachmentReader | undefined;
export async function readAssistantAttachment(
  ref: AssistantAttachmentRef,
  options: AssistantAttachmentReadOptions = {},
): Promise<AssistantAttachmentResult> {
  if (!hostReader) {
    const { createHostAssistantAttachmentReader } = await import('./assistant-attachment-host');
    hostReader = createHostAssistantAttachmentReader();
  }
  return hostReader.read(ref, options);
}
