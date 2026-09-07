// MIME parser - parses email structure and content

import { simpleParser, ParsedMail, Attachment, AddressObject, Headers } from 'mailparser';

import type { EmailAddress } from '../types/imap';
import { logger } from '../utils/logger';
import { SIMPLE_PARSER_OPTIONS } from '../utils/mail-parse';

/**
 * Parsed email content
 */
export interface ParsedEmail {
  // Headers
  subject: string | null;
  from: EmailAddress[];
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  replyTo: EmailAddress | null;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  date: Date;

  // Content
  text: string | null;
  html: string | null;
  textAsHtml: string | null;

  // Attachments
  attachments: ParsedAttachment[];
  hasAttachments: boolean;

  // Headers (using mailparser's Headers type)
  headers: Headers;
}

/**
 * Parsed attachment
 */
export interface ParsedAttachment {
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
  inline: boolean;
  content: Buffer;
}

/**
 * Flatten ONE value out of mailparser's `headers` map to a string.
 *
 * mailparser hands back a rich union, not strings: address headers become
 * `{ value: [...], text, html }`, `content-type`/`content-disposition` become
 * `{ value, params }`, `date` becomes a Date, and repeated headers become
 * arrays. `String(value)` therefore stored the literal `"[object Object]"` for
 * every structured header — From, To, Content-Type, DKIM params, the lot — so
 * anything reading normalized headers back (rules, debugging, header display)
 * saw nothing usable.
 *
 * Exported for direct unit testing: the shapes are the whole point.
 */
export function stringifyHeaderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map(stringifyHeaderValue).filter((part) => part.length > 0).join(', ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Address headers: `text` is mailparser's own rendering ("A <a@b.c>").
    if (typeof record.text === 'string') return record.text;
    // Structured headers: `value` plus RFC 2231 params (charset, boundary, …).
    if ('value' in record) {
      const head = stringifyHeaderValue(record.value);
      const params = record.params && typeof record.params === 'object'
        ? Object.entries(record.params as Record<string, unknown>)
          .map(([name, param]) => `${name}=${stringifyHeaderValue(param)}`)
        : [];
      return [head, ...params].filter((part) => part.length > 0).join('; ');
    }
    // Address objects that reached us without `text` (a hand-built parse).
    if (typeof record.address === 'string') {
      return typeof record.name === 'string' && record.name.length > 0
        ? `${record.name} <${record.address}>`
        : record.address;
    }
    // Nothing recognisable — JSON beats "[object Object]" for a reader.
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
}

/**
 * MIME Parser
 */
export class MimeParser {
  /**
   * Parse raw email message
   */
  async parse(rawMessage: string | Buffer): Promise<ParsedEmail> {
    try {
      const parsed = await simpleParser(rawMessage, SIMPLE_PARSER_OPTIONS);
      return this.convertParsedMail(parsed);
    } catch (error) {
      logger.error('Error parsing MIME message:', error);
      throw new Error(`Failed to parse MIME message: ${(error as Error).message}`);
    }
  }

  /**
   * Convert mailparser ParsedMail to our ParsedEmail format
   */
  private convertParsedMail(parsed: ParsedMail): ParsedEmail {
    return {
      // Headers
      subject: parsed.subject || null,
      from: this.convertAddresses(parsed.from),
      to: this.convertAddresses(parsed.to),
      cc: this.convertAddresses(parsed.cc),
      bcc: this.convertAddresses(parsed.bcc),
      replyTo: this.convertSingleAddress(parsed.replyTo),
      messageId: parsed.messageId || this.generateFallbackMessageId(),
      inReplyTo: parsed.inReplyTo || null,
      references: this.parseReferences(parsed.references),
      date: parsed.date || new Date(),

      // Content
      text: parsed.text || null,
      html: parsed.html as string || null,
      textAsHtml: parsed.textAsHtml || null,

      // Attachments
      attachments: this.convertAttachments(parsed.attachments),
      hasAttachments: (parsed.attachments?.length || 0) > 0,

      // Headers
      headers: parsed.headers,
    };
  }

  /**
   * Convert mailparser AddressObject to our EmailAddress array
   */
  private convertAddresses(addressObj: AddressObject | AddressObject[] | undefined): EmailAddress[] {
    if (!addressObj) {
      return [];
    }

    const addresses: EmailAddress[] = [];
    const addressArray = Array.isArray(addressObj) ? addressObj : [addressObj];

    for (const addr of addressArray) {
      if (addr.value) {
        for (const item of addr.value) {
          addresses.push({
            name: item.name || null,
            address: item.address || '',
          });
        }
      }
    }

    return addresses;
  }

  /**
   * Convert single address (for replyTo)
   */
  private convertSingleAddress(addressObj: AddressObject | AddressObject[] | undefined): EmailAddress | null {
    const addresses = this.convertAddresses(addressObj);
    return addresses.length > 0 ? addresses[0] : null;
  }

  /**
   * Parse references header
   */
  private parseReferences(references: string | string[] | undefined): string[] {
    if (!references) {
      return [];
    }

    if (typeof references === 'string') {
      // Split by whitespace and remove empty strings
      return references.split(/\s+/).filter(ref => ref.length > 0);
    }

    if (Array.isArray(references)) {
      return references.flatMap(ref =>
        ref.split(/\s+/).filter(r => r.length > 0)
      );
    }

    return [];
  }

  /**
   * Convert attachments
   */
  private convertAttachments(attachments: Attachment[] | undefined): ParsedAttachment[] {
    if (!attachments || attachments.length === 0) {
      return [];
    }

    return attachments.map(att => ({
      filename: att.filename || 'unnamed',
      contentType: att.contentType,
      size: att.size,
      // mailparser reports Content-ID with its angle brackets (`<abc@host>`)
      // while the HTML references it bare (`cid:abc@host`), so the raw value
      // never matched a `cid:` lookup. Store the bare form.
      contentId: att.contentId ? att.contentId.replace(/^<|>$/g, '') || null : null,
      // An embedded image is frequently sent with NO Content-Disposition at all —
      // only a Content-ID and a place in a multipart/related. Keying purely off
      // `contentDisposition === 'inline'` classified those as real attachments,
      // so a signature logo showed up as a downloadable file. `related` is
      // mailparser's own "this part is referenced by the body" flag.
      inline: att.contentDisposition === 'inline'
        || att.related === true
        || (!att.filename && Boolean(att.contentId)),
      content: att.content,
    }));
  }

  /**
   * Generate fallback message ID if none exists
   */
  private generateFallbackMessageId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `<${timestamp}.${random}@sarvinbox.local>`;
  }

  /**
   * Extract all text content from email (text + HTML)
   */
  extractAllText(parsed: ParsedEmail): string {
    const parts: string[] = [];

    if (parsed.text) {
      parts.push(parsed.text);
    }

    if (parsed.html && !parsed.text) {
      // If we have HTML but no text, we'll convert HTML to text later
      parts.push(parsed.html);
    }

    return parts.join('\n\n');
  }

  /**
   * Get best content representation
   * Prefers HTML if available, falls back to text
   */
  getBestContent(parsed: ParsedEmail): { type: 'html' | 'text', content: string } {
    if (parsed.html) {
      return { type: 'html', content: parsed.html };
    }

    if (parsed.text) {
      return { type: 'text', content: parsed.text };
    }

    return { type: 'text', content: '' };
  }

  /**
   * Normalize email headers for storage
   */
  normalizeHeaders(parsed: ParsedEmail): Record<string, string> {
    const normalized: Record<string, string> = {};

    // Convert headers Map to object
    parsed.headers.forEach((value, key) => {
      normalized[key.toLowerCase()] = stringifyHeaderValue(value);
    });

    return normalized;
  }
}

/**
 * Singleton instance
 */
export const mimeParser = new MimeParser();
