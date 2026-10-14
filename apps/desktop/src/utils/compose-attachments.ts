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
  hasAttachments?: boolean;
  attachmentNames?: string | null;
  attachmentSizes?: string | null;
  accountId?: string;
}

/**
 * Fetch every attachment of `email` as composer files — what a forward starts
 * with, and what a draft reopened from Drafts gets back. A file that fails to
 * load is skipped rather than failing the rest.
 */
export async function loadEmailAttachments(email: AttachmentSource, options: { requireAll?: boolean } = {}): Promise<AttachmentFile[]> {
  const declared = parseAttachments(email.attachmentNames, email.attachmentSizes);
  const loaded = await Promise.all(
    declared.map(async ({ name }): Promise<AttachmentFile | null> => {
      try {
        const result = await window.electronAPI.emails.getAttachmentBase64(email.id, name, email.accountId);
        if (!result.success || typeof result.base64 !== 'string') {
          if (options.requireAll) throw new Error(`Could not load attachment ${name}`);
          return null;
        }
        return {
          filename: name,
          content: result.base64,
          contentType: 'application/octet-stream', // nodemailer infers the real type from the filename
          encoding: 'base64',
          size: Math.floor(result.base64.length * 0.75) - (result.base64.endsWith('==') ? 2 : result.base64.endsWith('=') ? 1 : 0),
          type: 'attachment',
        };
      } catch (err) {
        if (options.requireAll) throw err;
        console.error(`Failed to load attachment ${name}:`, err);
        return null;
      }
    }),
  );
  return loaded.filter((file): file is AttachmentFile => file !== null);
}

/** A new forward carries every declared original file; a missing file blocks it.
 * Header-only sources first load their own authoritative attachment metadata. */
export async function loadForwardAttachments(source: AttachmentSource): Promise<AttachmentFile[]> {
  let email = source;
  if (source.hasAttachments && parseAttachments(source.attachmentNames, source.attachmentSizes).length === 0) {
    const result = await window.electronAPI.emails.fetchBody(source.id, source.accountId);
    if (!result.success || !result.data) throw new Error('Could not load forwarded attachment metadata');
    email = { ...source, ...result.data, accountId: source.accountId };
    if (email.hasAttachments && parseAttachments(email.attachmentNames, email.attachmentSizes).length === 0) {
      throw new Error('Forwarded attachment metadata is unavailable');
    }
  }
  return loadEmailAttachments(email, { requireAll: true });
}
