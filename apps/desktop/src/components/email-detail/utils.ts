import { parseAttachmentNames } from '@sarvinbox/core/attachment-kind';
import { format, differenceInCalendarDays, differenceInHours, differenceInMinutes, isToday } from 'date-fns';
import {
  FileText,
  FileImage,
  FileSpreadsheet,
  FileArchive,
  File,
  FileVideo,
  FileAudio,
  FileCode,
} from 'lucide-react';
import * as React from 'react';


// Get file icon based on extension
export function getFileIcon(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() || '';

  const iconMap: Record<string, React.ReactNode> = {
    // Documents
    pdf: React.createElement(FileText, { className: 'h-8 w-8 text-red-500' }),
    doc: React.createElement(FileText, { className: 'h-8 w-8 text-blue-500' }),
    docx: React.createElement(FileText, { className: 'h-8 w-8 text-blue-500' }),
    txt: React.createElement(FileText, { className: 'h-8 w-8 text-gray-500' }),
    rtf: React.createElement(FileText, { className: 'h-8 w-8 text-gray-500' }),
    // Spreadsheets
    xls: React.createElement(FileSpreadsheet, { className: 'h-8 w-8 text-green-600' }),
    xlsx: React.createElement(FileSpreadsheet, { className: 'h-8 w-8 text-green-600' }),
    csv: React.createElement(FileSpreadsheet, { className: 'h-8 w-8 text-green-600' }),
    // Images
    jpg: React.createElement(FileImage, { className: 'h-8 w-8 text-purple-500' }),
    jpeg: React.createElement(FileImage, { className: 'h-8 w-8 text-purple-500' }),
    png: React.createElement(FileImage, { className: 'h-8 w-8 text-purple-500' }),
    gif: React.createElement(FileImage, { className: 'h-8 w-8 text-purple-500' }),
    svg: React.createElement(FileImage, { className: 'h-8 w-8 text-purple-500' }),
    webp: React.createElement(FileImage, { className: 'h-8 w-8 text-purple-500' }),
    // Archives
    zip: React.createElement(FileArchive, { className: 'h-8 w-8 text-yellow-600' }),
    rar: React.createElement(FileArchive, { className: 'h-8 w-8 text-yellow-600' }),
    '7z': React.createElement(FileArchive, { className: 'h-8 w-8 text-yellow-600' }),
    tar: React.createElement(FileArchive, { className: 'h-8 w-8 text-yellow-600' }),
    gz: React.createElement(FileArchive, { className: 'h-8 w-8 text-yellow-600' }),
    // Video
    mp4: React.createElement(FileVideo, { className: 'h-8 w-8 text-pink-500' }),
    avi: React.createElement(FileVideo, { className: 'h-8 w-8 text-pink-500' }),
    mov: React.createElement(FileVideo, { className: 'h-8 w-8 text-pink-500' }),
    mkv: React.createElement(FileVideo, { className: 'h-8 w-8 text-pink-500' }),
    // Audio
    mp3: React.createElement(FileAudio, { className: 'h-8 w-8 text-orange-500' }),
    wav: React.createElement(FileAudio, { className: 'h-8 w-8 text-orange-500' }),
    ogg: React.createElement(FileAudio, { className: 'h-8 w-8 text-orange-500' }),
    // Code
    js: React.createElement(FileCode, { className: 'h-8 w-8 text-yellow-500' }),
    ts: React.createElement(FileCode, { className: 'h-8 w-8 text-blue-500' }),
    html: React.createElement(FileCode, { className: 'h-8 w-8 text-orange-500' }),
    css: React.createElement(FileCode, { className: 'h-8 w-8 text-blue-400' }),
    json: React.createElement(FileCode, { className: 'h-8 w-8 text-gray-500' }),
  };

  return iconMap[ext] || React.createElement(File, { className: 'h-8 w-8 text-muted-foreground' });
}

// The attachment allow-list lives in core (`utils/attachment-kind.ts`) so the
// `sarv-attachment://` handler in the main process and this renderer classify a
// file identically. Re-exported here because the components in this folder have
// always imported it from `./utils`.
export { isPreviewableAttachment } from '@sarvinbox/core/attachment-kind';

// Get file type label
export function getFileType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const typeMap: Record<string, string> = {
    pdf: 'PDF',
    doc: 'Word',
    docx: 'Word',
    xls: 'Excel',
    xlsx: 'Excel',
    csv: 'CSV',
    jpg: 'Image',
    jpeg: 'Image',
    png: 'Image',
    gif: 'Image',
    zip: 'Archive',
    rar: 'Archive',
    mp4: 'Video',
    mp3: 'Audio',
  };
  return typeMap[ext] || ext.toUpperCase();
}

// Reply-attribution lines ("On <date>, <name> wrote:", "-----Original Message-----").
// NOTE the required "On " prefix / dashes: a bare "Sohum Jadeja wrote:" (as some
// notification services emit before the ACTUAL message) is deliberately NOT a
// match — otherwise the real content gets hidden as a "quote".
const REPLY_ATTRIBUTION_RE = /^(On\b[\s\S]{0,400}\bwrote:|[-_]{2,}\s*Original Message\s*[-_]{2,}|Begin forwarded message:)\s*$/i;
// Outlook desktop's forwarded/reply header block starts with these field labels.
const OUTLOOK_HEADER_RE = /^From:\s.+[\s\S]{0,300}\b(Sent|Date):\s/i;

/**
 * Remove a boundary node and everything AFTER it in document order, while
 * preserving every ancestor and all content that comes BEFORE it. (Deleting the
 * ancestors outright would also drop the pre-quote content nested alongside the
 * quote — the classic "half the email vanished" bug.)
 */
function removeFromNodeOnward(node: Node, root: Node): void {
  let cur: Node | null = node;
  while (cur && cur !== root && cur.parentNode) {
    let sib = cur.nextSibling;
    while (sib) {
      const next = sib.nextSibling;
      sib.parentNode?.removeChild(sib);
      sib = next;
    }
    cur = cur.parentNode;
  }
  node.parentNode?.removeChild(node);
}

/**
 * Locate the FIRST genuine reply/forward quote boundary in the document.
 * Only structural reply markers (Gmail's `.gmail_quote`, Apple's
 * `blockquote[type="cite"]`, Outlook's reply containers) and real attribution
 * lines count — a plain styled `<blockquote>` used to present content (e.g. a
 * notification quoting a task comment) is intentionally left alone.
 */
function findQuoteBoundary(doc: Document): Element | null {
  const candidates: Element[] = [];

  // Structural, unambiguous reply/forward containers.
  const structural = doc.body.querySelector(
    '.gmail_quote, blockquote[type="cite" i], #appendonsend, #divRplyFwdMsg, #mail-editor-reference-message-container, [name="messageReplySection"]',
  );
  if (structural) candidates.push(structural);

  // Text-attribution boundaries + Outlook desktop's border-top separator.
  const blocks = doc.body.querySelectorAll('div, p, blockquote, span, hr, table');
  for (const el of Array.from(blocks)) {
    const text = (el.textContent || '').trim();
    if (text.length > 0 && text.length <= 420 && REPLY_ATTRIBUTION_RE.test(text)) {
      candidates.push(el);
      break; // earliest in this scan is enough; ranked against structural below
    }
    if (OUTLOOK_HEADER_RE.test(text) && text.length <= 600) {
      candidates.push(el);
      break;
    }
  }

  if (candidates.length === 0) return null;
  // Pick the earliest in document order so we don't strip content that precedes
  // the true quote.
  return candidates.reduce((earliest, el) =>
    earliest.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING ? el : earliest,
  );
}

export function stripQuotedContent(body: string | null, isHtml: boolean): { newContent: string; hasQuoted: boolean } {
  if (!body) return { newContent: '', hasQuoted: false };

  if (isHtml) {
    // Prefer real DOM parsing (renderer) over regex — HTML quote structure is
    // nested and regex "from marker to end of string" both over-matches (hides
    // content blockquotes) and can slice mid-tag. Fall back to a conservative
    // regex only where DOMParser is unavailable (tests / SSR).
    if (typeof DOMParser === 'undefined') {
      const conservative = [
        /<div class="gmail_quote"[\s\S]*$/i,
        /<div id="appendonsend"[\s\S]*$/i,
        /<blockquote[^>]*type=["']?cite["']?[\s\S]*$/i,
      ];
      let result = body;
      let hasQuoted = false;
      for (const p of conservative) {
        if (p.test(result)) { result = result.replace(p, ''); hasQuoted = true; }
      }
      return { newContent: result.trim(), hasQuoted };
    }

    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(body, 'text/html');
    } catch {
      return { newContent: body, hasQuoted: false };
    }
    const boundary = findQuoteBoundary(doc);
    if (!boundary) return { newContent: body, hasQuoted: false };
    removeFromNodeOnward(boundary, doc.body);
    return { newContent: doc.body.innerHTML.trim(), hasQuoted: true };
  } else {
    // For plain text
    const lines = body.split('\n');
    const newLines: string[] = [];
    let hasQuoted = false;
    let inQuote = false;

    for (const line of lines) {
      // Detect start of quoted content
      if (
        line.match(/^On .+ wrote:$/i) ||
        line.match(/^-{3,}\s*Original Message\s*-{3,}$/i) ||
        line.match(/^From:\s+.+$/i) && newLines.length > 0 ||
        line.match(/^>{1,}/) ||
        line.match(/^Sent from my/i)
      ) {
        inQuote = true;
        hasQuoted = true;
        continue;
      }

      if (!inQuote) {
        newLines.push(line);
      }
    }

    // Remove trailing empty lines
    while (newLines.length > 0 && newLines[newLines.length - 1].trim() === '') {
      newLines.pop();
    }

    return { newContent: newLines.join('\n'), hasQuoted };
  }
}

// Common signature selectors to try (synchronous)
export const SIGNATURE_SELECTORS = [
  // Gmail signatures
  'div.gmail_signature[data-smartmail="gmail_signature"]',
  'div.gmail_signature',
  // Gmail signatures inside quotes
  '.gmail_quote div.gmail_signature',
  'blockquote div.gmail_signature',
  // Outlook signatures
  '#Signature',
  '#signature',
  'div[id*="signature" i]',
  // Outlook signatures inside quotes
  'blockquote #Signature',
  'blockquote #signature',
  // Apple Mail
  'div.AppleMailSignature',
  'blockquote div.AppleMailSignature',
  // Generic signatures
  'div.signature',
  'div.email-signature',
  'table.signature',
  '.sig',
  // Signatures inside blockquotes
  'blockquote div.signature',
  'blockquote .sig',
];

// Synchronous helper to strip ALL signatures from HTML body (handles email threads)
export function stripSignatureFromHtml(body: string): { newContent: string; hasSignature: boolean } {
  if (!body) return { newContent: '', hasSignature: false };

  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(body, 'text/html');
    let totalRemoved = 0;

    // Remove ALL matching signature elements for each selector
    for (const selector of SIGNATURE_SELECTORS) {
      try {
        const elements = doc.querySelectorAll(selector);
        if (elements.length > 0) {
          console.log(`[Signature Strip] Found ${elements.length} element(s) matching "${selector}"`);
          elements.forEach(el => el.remove());
          totalRemoved += elements.length;
        }
      } catch {
        // Invalid selector, skip
      }
    }

    if (totalRemoved > 0) {
      console.log(`[Signature Strip] Total removed: ${totalRemoved} signature element(s)`);
      return {
        newContent: doc.body.innerHTML,
        hasSignature: true,
      };
    }
  } catch (error) {
    console.error('[EmailDetail] Failed to strip signatures:', error);
  }

  return { newContent: body, hasSignature: false };
}

/**
 * Format date with relative time
 * - Today: "4:05 PM (7 minutes ago)"
 * - Within 30 days: "Jan 5 (3 days ago)"
 * - Older: "Dec 10, 2024"
 */
export function formatRelativeDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const daysDiff = differenceInCalendarDays(now, date);

  if (isToday(date)) {
    const hoursDiff = differenceInHours(now, date);
    const minutesDiff = differenceInMinutes(now, date);

    let relativeText: string;
    if (minutesDiff < 1) {
      relativeText = 'just now';
    } else if (minutesDiff < 60) {
      relativeText = `${minutesDiff} min ago`;
    } else if (hoursDiff < 24) {
      const remainingMinutes = minutesDiff % 60;
      if (remainingMinutes > 0) {
        relativeText = `${hoursDiff} hr ${remainingMinutes} min ago`;
      } else {
        relativeText = `${hoursDiff} hr ago`;
      }
    } else {
      relativeText = 'today';
    }

    return `${format(date, 'h:mm a')} (${relativeText})`;
  } else if (daysDiff <= 30) {
    return `${format(date, 'MMM d')} (${daysDiff} day${daysDiff === 1 ? '' : 's'} ago)`;
  } else {
    return format(date, 'MMM d, yyyy');
  }
}

export interface ParsedAttachment {
  name: string;
  /** Byte size, or null when unknown (legacy rows without size metadata). */
  size: number | null;
}

/**
 * Parse an email's stored attachment metadata into {name, size} pairs. The
 * single source of truth for this — `attachmentNames` is a JSON array (current)
 * or a legacy comma-joined string, and `attachmentSizes` is a parallel JSON
 * array of byte counts (absent on legacy rows). Callers previously hand-rolled
 * `attachmentNames.split(',')`, which leaked JSON punctuation (`["report.pdf"`)
 * into the UI for the current format. A first attachment literally named
 * "[x] y.pdf" also starts with '[' but isn't JSON — fall back to comma-split
 * rather than crash.
 */
export function parseAttachments(
  attachmentNames?: string | null,
  attachmentSizes?: string | null,
): ParsedAttachment[] {
  // The name parsing itself is `parseAttachmentNames` in core — the SAME
  // function the main process authorizes a request with. If the two ever read
  // the column differently, a legitimate attachment the UI offered would be
  // refused (or worse, one it never showed would be served).
  const names = parseAttachmentNames(attachmentNames);
  if (names.length === 0) return [];
  let sizes: number[] = [];
  if (attachmentSizes) {
    try {
      const s = JSON.parse(attachmentSizes);
      if (Array.isArray(s)) sizes = s.map((v) => Number(v));
    } catch { /* ignore — sizes stay unknown */ }
  }
  return names.map((name, i) => ({
    name,
    size: Number.isFinite(sizes[i]) && sizes[i] > 0 ? sizes[i] : null,
  }));
}

// Get initials from name or email
export function getInitials(name: string | null, email: string): string {
  if (name) {
    const parts = name.trim().split(' ');
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].substring(0, 2).toUpperCase();
  }
  return email.substring(0, 2).toUpperCase();
}

// Generate color from email address
export function getAvatarColor(email: string): string {
  const colors = [
    'bg-blue-500',
    'bg-green-500',
    'bg-purple-500',
    'bg-pink-500',
    'bg-orange-500',
    'bg-teal-500',
    'bg-indigo-500',
    'bg-red-500',
  ];
  const index = email.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[index % colors.length];
}

/** A row identified only by the two fields the draft flow keys off. */
export interface ThreadKeyed {
  id?: string;
  threadId?: string | null;
}

/**
 * Every thread key a set of rows could legitimately be identified by.
 *
 * The auto-open-a-saved-draft flow suppresses itself per thread, but the thread
 * it RECORDS on close and the thread it CHECKS on the next render were not read
 * off the same row: the newest message can be an optimistic sent row that has
 * not been threaded yet, so a single-key check missed the match and the
 * just-sent draft re-opened underneath the sent mail. BOTH sides now go through
 * this helper over the same rows, so the two can no longer disagree.
 */
export function threadKeysOf(
  rows: ReadonlyArray<ThreadKeyed | null | undefined> | null | undefined,
): string[] {
  const keys = new Set<string>();
  for (const row of rows ?? []) {
    if (!row) continue;
    // An unthreaded row (an optimistic send, a standalone draft) is its own thread.
    const key = row.threadId || row.id;
    if (key) keys.add(key);
  }
  return [...keys];
}

/**
 * The thread(s) an in-flight send belongs to.
 *
 * A send is held in the outbox for the undo window before its draft is deleted,
 * so during those seconds the draft legitimately still exists — and the
 * optimistic sent row re-triggers the auto-open effect at exactly that moment.
 * Suppressing on `pendingSend` alone would silence EVERY thread's draft while
 * any send is in flight (the effect does not re-run when the window closes, so
 * that silence would stick), hence keying it to the send's own thread.
 */
export function pendingSendThreadKeys(pendingSend: {
  draftCleanup?: { threadId?: string } | null;
  draft?: { replyToEmail?: ThreadKeyed | null } | null;
} | null | undefined): string[] {
  if (!pendingSend) return [];
  return threadKeysOf([
    pendingSend.draftCleanup?.threadId ? { threadId: pendingSend.draftCleanup.threadId } : null,
    pendingSend.draft?.replyToEmail,
  ]);
}

/**
 * Whether the reading pane must NOT auto-open a saved draft right now — because
 * the user already sent or dismissed this thread's draft in this session, or
 * because a send for this very thread is still inside its undo window and the
 * draft it is about to delete is the one we would be re-opening.
 */
export function shouldSuppressDraftAutoOpen(
  threadKeys: readonly string[],
  dismissedThreads: ReadonlySet<string>,
  sendingThreadKeys: readonly string[] | null | undefined,
): boolean {
  if (threadKeys.some((key) => dismissedThreads.has(key))) return true;
  const sending = sendingThreadKeys ?? [];
  return threadKeys.some((key) => sending.includes(key));
}

/**
 * Is this message's body in hand?
 *
 * Bodies are fetched lazily — a row arrives with its headers and gets its body
 * on demand — so a message with neither part has not been downloaded yet, not
 * downloaded-and-empty. Everything that reads the body owes the reader that
 * distinction: the renderer shows a spinner rather than "(no content)", and
 * the security shield reports its link checks as unrun rather than passed.
 * One definition, because four views asking it differently is how they end up
 * disagreeing about the same message.
 */
export function hasLoadedBody(email: { rawBody?: string | null; cleanBody?: string | null }): boolean {
  return Boolean(email.rawBody || email.cleanBody);
}
