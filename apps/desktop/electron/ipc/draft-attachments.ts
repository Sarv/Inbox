/**
 * The attachments a draft carries: what the renderer sends with a save, the
 * MIME parts they become, and the attachment columns of the local draft row.
 *
 * Pure — no I/O — so the save path in `draft-handlers.ts` stays the only place
 * that writes, and these rules can be tested on their own.
 */

/** A file attached to a draft, as the composer holds it (base64 content). */
export interface DraftAttachment {
  filename: string;
  content: string;
  contentType?: string;
}

/** A decoded draft attachment, ready for MIME and for the attachment cache. */
export interface DecodedDraftAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/**
 * Keep only well-formed entries and decode them. The list comes over IPC, so a
 * malformed entry is dropped rather than allowed to fail the whole save — a
 * draft missing one broken file beats a draft that isn't saved at all.
 */
export function decodeDraftAttachments(input: unknown): DecodedDraftAttachment[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((entry): entry is DraftAttachment =>
      !!entry
      && typeof entry.filename === 'string' && entry.filename.length > 0
      && typeof entry.content === 'string')
    .map((entry) => ({
      filename: entry.filename,
      content: Buffer.from(entry.content, 'base64'),
      ...(typeof entry.contentType === 'string' && entry.contentType ? { contentType: entry.contentType } : {}),
    }));
}

/** The nodemailer attachment list for the draft's MIME message. */
export function draftMimeAttachments(files: DecodedDraftAttachment[]) {
  return files.map((file) => ({
    filename: file.filename,
    content: file.content,
    ...(file.contentType ? { contentType: file.contentType } : {}),
  }));
}

/**
 * The attachment columns of the local draft row, in the same shapes the sync
 * path writes them (a JSON name list and a parallel JSON size list), so the
 * Drafts list shows the paperclip and a reopened draft finds its files.
 */
export function draftAttachmentColumns(files: DecodedDraftAttachment[]): {
  hasAttachments: 0 | 1;
  attachmentCount: number;
  attachmentNames: string;
  attachmentSizes: string | null;
} {
  if (files.length === 0) {
    return { hasAttachments: 0, attachmentCount: 0, attachmentNames: '', attachmentSizes: null };
  }
  return {
    hasAttachments: 1,
    attachmentCount: files.length,
    attachmentNames: JSON.stringify(files.map((file) => file.filename)),
    attachmentSizes: JSON.stringify(files.map((file) => file.content.length)),
  };
}
