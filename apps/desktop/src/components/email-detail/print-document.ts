import { escapeHtml } from '@sarvinbox/core/html-escape';

import { withLeadingCsp } from '../../utils/email-frame-csp';
import { stripActiveContent } from '../../utils/email-strip';
import { remoteImageFactsOf, shouldAutoLoadRemoteImages } from '../../utils/remote-images';

/** The fields of an email the print view shows. */
export interface PrintableEmail {
  subject?: string | null;
  fromName?: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
  ccAddress?: string | null;
  /** Unix seconds. */
  date: number;
  rawBody?: string | null;
  cleanBody?: string | null;
}

/**
 * The document printed for one email (CASA M-4).
 *
 * Two things it must never do. Fetch anything remote the viewer wouldn't: it
 * carries the same leading CSP as the on-screen frame, so a tracking pixel in
 * the body does not fire just because the user printed — remote images load
 * only when `allowRemoteImages` (the user's auto-load rules for this sender) —
 * and the body loses its scripts, links and nested frames (stripActiveContent),
 * because a DNS-prefetch hint is outside any CSP; its styles print as sent.
 * And let anything but that body become markup: subject, names, addresses and
 * the plain-text fallback (a body not loaded yet) are sender-controlled text
 * and are escaped.
 */
export function buildPrintDocument(email: PrintableEmail, allowRemoteImages: boolean): string {
  const text = (value: string | null | undefined) => escapeHtml(value ?? '');
  const subject = text(email.subject || '(no subject)');
  const from = email.fromName ? `${text(email.fromName)} &lt;${text(email.fromAddress)}&gt;` : text(email.fromAddress);
  const date = text(new Date(email.date * 1000).toLocaleString());
  const html = `<!DOCTYPE html>
      <html>
      <head>
        <title>Print Email - ${subject}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; }
          .header { border-bottom: 1px solid #e5e7eb; padding-bottom: 20px; margin-bottom: 20px; }
          .subject { font-size: 24px; font-weight: bold; margin-bottom: 16px; }
          .meta { color: #6b7280; font-size: 14px; line-height: 1.6; }
          .meta strong { color: #374151; }
          .body { line-height: 1.6; }
          @media print { body { padding: 20px; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="subject">${subject}</div>
          <div class="meta">
            <div><strong>From:</strong> ${from}</div>
            <div><strong>To:</strong> ${text(email.toAddress)}</div>
            ${email.ccAddress ? `<div><strong>Cc:</strong> ${text(email.ccAddress)}</div>` : ''}
            <div><strong>Date:</strong> ${date}</div>
          </div>
        </div>
        <div class="body">${email.rawBody ? stripActiveContent(email.rawBody) : `<div style="white-space: pre-wrap">${text(email.cleanBody || '(no content)')}</div>`}</div>
      </body>
      </html>`;
  return withLeadingCsp(html, allowRemoteImages);
}

/**
 * The print document for `email` as the reading pane shows it. Remote images
 * print only if the user's rules auto-load them for this sender on this
 * message's account — its own, else the pane's (a thread row in All Inboxes
 * carries none) — the same decision the on-screen frame makes. Deciding on the
 * active account instead let Print load a pixel the screen blocked.
 */
export function printDocumentFor(
  email: PrintableEmail & { tags?: string | null; authStatus?: string | null; accountId?: string | null },
  paneAccountId: string | null,
): string {
  return buildPrintDocument(email, shouldAutoLoadRemoteImages(remoteImageFactsOf(email, paneAccountId)));
}
