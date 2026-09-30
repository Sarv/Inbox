import type { AttachmentFile } from '../components/useCompose';

import { loadEmailAttachments, type AttachmentSource } from './compose-attachments';

/** Plain text as editor paragraphs, one per line — an empty line keeps its height. */
export const textToParagraphsHtml = (text: string): string =>
  text
    .split('\n')
    .map((line) => `<p>${line || '&nbsp;'}</p>`)
    .join('');

/** A saved draft row, as the thread view and `drafts.findForThread` hand it over. */
export interface SavedDraftRow extends AttachmentSource {
  cleanBody?: string | null;
  rawBody?: string | null;
  htmlBody?: string | null;
  pgpStatus?: 'encrypted' | 'signed' | null;
}

/** What a composer reopens a saved draft with. */
export interface SavedDraftContent {
  htmlContent: string;
  attachments: AttachmentFile[];
  /** Saved encrypted: the composer reopens with encryption on, so it stays encrypted. */
  pgpEncrypted: boolean;
}

async function openEncryptedDraft(draft: SavedDraftRow): Promise<SavedDraftContent | null> {
  const opened = await window.electronAPI.pgp.openDraft(draft.id, draft.accountId);
  if (!opened.ok) {
    console.warn('[Draft] Encrypted draft could not be opened:', opened.code, opened.error);
    return null;
  }
  return {
    htmlContent: opened.contentType === 'html' ? opened.body : textToParagraphsHtml(opened.body),
    attachments: opened.attachments.map((file) => ({ ...file, type: 'attachment' })),
    pgpEncrypted: true,
  };
}

/**
 * A saved draft's body and files for the composer. An encrypted draft's row
 * holds only a placeholder, so it is decrypted by the main process instead;
 * null when that fails (no key, a locked key) — opening the placeholder as the
 * draft would let the next autosave overwrite the real one with it.
 */
export async function savedDraftContent(draft: SavedDraftRow): Promise<SavedDraftContent | null> {
  if (draft.pgpStatus === 'encrypted') return openEncryptedDraft(draft);
  return {
    htmlContent: draft.cleanBody ? textToParagraphsHtml(draft.cleanBody) : draft.rawBody || draft.htmlBody || '',
    attachments: await loadEmailAttachments(draft),
    pgpEncrypted: false,
  };
}
