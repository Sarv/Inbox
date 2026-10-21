import type { AttachmentFile } from '../components/useCompose';
import type { LocalCalendarAvailability } from '../types/local-calendar';

import { loadEmailAttachments, type AttachmentSource } from './compose-attachments';

/** Plain text as editor paragraphs, one per line — an empty line keeps its height. */
export const textToParagraphsHtml = (text: string): string =>
  text
    .split('\n')
    .map((line) => `<p>${line || '&nbsp;'}</p>`)
    .join('');

/** A saved draft row, as the thread view and `drafts.findForThread` hand it over. */
export interface SavedDraftRow extends AttachmentSource {
  /** MIME Message-ID, distinct from the local email row id. */
  messageId?: string | null;
  message_id?: string | null;
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
  /** App-local scheduling proof; never part of the saved email body or MIME. */
  calendarAvailability?: LocalCalendarAvailability;
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
  const getAvailability = window.electronAPI?.drafts?.getCalendarAvailability;
  const messageId = [draft.messageId, draft.message_id].find(value => typeof value === 'string' && value.trim().length > 0);
  let calendarAvailability: LocalCalendarAvailability | undefined;
  // Older bridge/test contexts and legacy rows have no app-local metadata API
  // or canonical Message-ID. Never substitute the unrelated local row id.
  if (getAvailability && messageId) {
    try {
      const result = await getAvailability(messageId, draft.accountId);
      if (!result?.success) throw new Error('Saved calendar check unavailable');
      calendarAvailability = result.data;
    } catch {
      window.alert('Could not load this draft’s saved calendar check. The draft was not opened. Please try again.');
      return null;
    }
  }
  const content = draft.pgpStatus === 'encrypted' ? await openEncryptedDraft(draft) : {
    htmlContent: draft.cleanBody ? textToParagraphsHtml(draft.cleanBody) : draft.rawBody || draft.htmlBody || '',
    attachments: await loadEmailAttachments(draft),
    pgpEncrypted: false,
  };
  if (!content) return null;
  return { ...content, ...(calendarAvailability ? { calendarAvailability } : {}) };
}
