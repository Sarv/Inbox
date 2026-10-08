import { escapeHtml } from '@sarvinbox/core/html-escape';

import { withLeadingCsp } from '../../utils/email-frame-csp';

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
 * only when `allowRemoteImages` (the user's auto-load rules for this sender).
 * And let a header field become markup: subject, names and addresses are
 * sender-controlled text and are escaped; only the body is HTML.
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
        <div class="body">${email.rawBody || email.cleanBody || '(no content)'}</div>
      </body>
      </html>`;
  return withLeadingCsp(html, allowRemoteImages);
}
