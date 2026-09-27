import { parseAttachments } from '../components/email-detail/utils';
import type { AttachmentFile } from '../components/useCompose';

/** A composer attachment as `drafts.save` takes it: name, base64 bytes, type. */
export interface DraftAttachmentPayload {
  filename: string;
  content: string;
  contentType?: string;
}

const nameOf = (file: AttachmentFile) => file.filename || file.name || 'attachment';

/**
 * The composer's files as a draft saves them. A file whose bytes never loaded
 * (no `content`) is left out — it has nothing to store.
 */
export function toDraftAttachments(files: AttachmentFile[] | undefined): DraftAttachmentPayload[] {
  return (files ?? [])
    .filter((file) => typeof file.content === 'string')
    .map((file) => ({
      filename: nameOf(file),
      content: file.content as string,
      ...(file.contentType ? { contentType: file.contentType } : {}),
    }));
}

/**
 * A fingerprint of the attached files, for change detection: adding or
 * removing one is an edit worth saving, like typing is.
 */
export function attachmentsKey(files: AttachmentFile[] | undefined): string {
  return (files ?? []).map((file) => `${nameOf(file)}:${file.size}`).join('\u0001');
}

/** The mail whose attachments are wanted: a received message or a saved draft. */
export interface AttachmentSource {
  id: string;
  attachmentNames?: string | null;
  attachmentSizes?: string | null;
  accountId?: string;
}

/**
 * Fetch every attachment of `email` as composer files — what a forward starts
 * with, and what a draft reopened from Drafts gets back. A file that fails to
 * load is skipped rather than failing the rest.
 */
export async function loadEmailAttachments(email: AttachmentSource): Promise<AttachmentFile[]> {
  const declared = parseAttachments(email.attachmentNames, email.attachmentSizes);
  const loaded = await Promise.all(
    declared.map(async ({ name }): Promise<AttachmentFile | null> => {
      try {
        const result = await window.electronAPI.emails.getAttachmentBase64(email.id, name, email.accountId);
        if (!result.success || !result.base64) return null;
        return {
          filename: name,
          content: result.base64,
          contentType: 'application/octet-stream', // nodemailer infers the real type from the filename
          encoding: 'base64',
          size: Math.round(result.base64.length * 0.75), // byte size from the base64 length
          type: 'attachment',
        };
      } catch (err) {
        console.error(`Failed to load attachment ${name}:`, err);
        return null;
      }
    }),
  );
  return loaded.filter((file): file is AttachmentFile => file !== null);
}
