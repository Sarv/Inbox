// Content cleaner - removes quotes, signatures, and reply chains

import { logger } from '../utils/logger';

/**
 * Cleaning options
 */
export interface CleaningOptions {
  removeQuotes?: boolean;
  removeSignatures?: boolean;
  removeForwardedContent?: boolean;
  preserveFormatting?: boolean;
  maxSignatureLines?: number;
}

/**
 * Cleaned content result
 */
export interface CleanedContent {
  cleanText: string;
  originalText: string;
  removedQuotes: number;
  removedSignature: boolean;
  removedForwarded: boolean;
}

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * `/^Am .+ schrieb .+:$/m` — a German attribution, "Am <date> schrieb <name>:" —
 * as a scan. The regex tried every " schrieb " in the line for its first `.+`
 * and ran the second `.+` to the end of the line from each one, so a line of
 * many " schrieb " with no closing colon was quadratic (CodeQL
 * js/polynomial-redos; 40 K of them took 6.5 s). If the FIRST " schrieb " that
 * leaves a character after "Am " can't be followed by one more character and
 * the closing colon, no later one can.
 */
function isGermanAttribution(line: string): boolean {
  const marker = ' schrieb ';
  for (const part of line.split(LINE_TERMINATOR)) {
    if (!part.startsWith('Am ') || !part.endsWith(':')) continue;
    const at = part.indexOf(marker, 'Am '.length + 1);
    if (at !== -1 && at + marker.length < part.length - 1) return true;
  }
  return false;
}

/**
 * Quote patterns
 *
 * NOTE: these are used with .test() per line — no `g` flag, or lastIndex
 * persists across calls and alternates false negatives on repeated lines.
 *
 * Each must stay linear on one long line — a body line is a stranger's text:
 *
 *   * The `>` and `|` markers allow leading whitespace that is NOT a line
 *     terminator (`[^\S\n\r\u2028\u2029]`, not `\s`). Under `m` every `\r`
 *     inside a line starts a new `^`, and a leading `\s*` — which also eats
 *     terminators — rescanned the rest of a long `\r` run from each one:
 *     quadratic (40 K `\r` took 0.7 s per pattern). The same lines match: the
 *     last `^` in such a run sits right after its last terminator.
 *   * There is no separate "On [date], [name] wrote:" pattern: `/^On .+, .+
 *     wrote:$/m` matched only lines `/^On .+ wrote:$/m` already matches, and
 *     its two `.+` around ", " made a long line of ", " with no "wrote:"
 *     quadratic (CodeQL js/polynomial-redos; 40 K took 2.2 s).
 *   * The German attribution is a scan, see {@link isGermanAttribution}.
 */
const QUOTE_PATTERNS: ReadonlyArray<{ test(line: string): boolean }> = [
  /^[^\S\n\r\u2028\u2029]*>+\s/m,                  // > quote markers
  /^[^\S\n\r\u2028\u2029]*\|/m,                     // | quote markers (Outlook)
  /^On .+ wrote:$/m,                                // On [date] [name] wrote:, On [date], [name] wrote:
  /^From: .+$/m,                                    // From: [name]
  /^Sent: .+$/m,                                    // Sent: [date]
  /^To: .+$/m,                                      // To: [name]
  /^Subject: .+$/m,                                 // Subject: [subject]
  /^-----Original Message-----$/m,                  // Outlook original message
  /^________________________________$/m,             // Outlook separator
  /^Le .+ a écrit :$/m,                            // French: Le [date] a écrit :
  { test: isGermanAttribution },                    // German: Am [date] schrieb [name]:
  /^El .+ escribió:$/m,                            // Spanish: El [date] escribió:
];

/**
 * Signature patterns (used with .test() per line — no `g` flag, see above)
 */
const SIGNATURE_PATTERNS = [
  /^--[\s]*$/m,                                     // Standard -- separator
  /^—+[\s]*$/m,                                     // Em dash separator
  /^___+[\s]*$/m,                                   // Underscore separator
  /^Sent from my (iPhone|iPad|Android|BlackBerry)/mi, // Mobile signatures
  /^Get Outlook for (iOS|Android)/mi,               // Outlook mobile
  /^Sent via /mi,                                   // Generic sent via
  /^Best regards?,?$/mi,                            // Best regards
  /^Kind regards?,?$/mi,                            // Kind regards
  /^Sincerely,?$/mi,                                // Sincerely
  /^Thanks?,?$/mi,                                  // Thanks
  /^Cheers,?$/mi,                                   // Cheers
  /^Warm regards?,?$/mi,                            // Warm regards
];

/**
 * Forwarded message patterns
 *
 * "Forwarded by … on …" ends in a single `.`: it was `.+$`, which under `m`
 * matches as soon as one character follows " on " (`.` and `$` stop at the same
 * line terminators), so `search()` finds the same line start either way. With
 * one `.+` per line start there is nothing to backtrack between (CodeQL
 * js/polynomial-redos flagged the pair).
 */
const FORWARDED_PATTERNS = [
  /^-+\s*Forwarded message\s*-+/gmi,                // Gmail forwarded
  /^Begin forwarded message:/gmi,                    // Apple Mail
  /^Forwarded by .+ on ./gmi,                       // Generic forwarded
  /^FW:/gmi,                                         // FW: prefix
  /^Fwd:/gmi,                                        // Fwd: prefix
];

/**
 * Content Cleaner
 */
export class ContentCleaner {
  /**
   * Clean email content
   */
  clean(text: string, options: CleaningOptions = {}): CleanedContent {
    const opts = {
      removeQuotes: options.removeQuotes !== false,
      removeSignatures: options.removeSignatures !== false,
      removeForwardedContent: options.removeForwardedContent !== false,
      preserveFormatting: options.preserveFormatting || false,
      maxSignatureLines: options.maxSignatureLines || 10,
    };

    let cleanText = text;
    let removedQuotes = 0;
    let removedSignature = false;
    let removedForwarded = false;

    try {
      // Step 1: Remove forwarded content
      if (opts.removeForwardedContent) {
        const result = this.removeForwardedContent(cleanText);
        cleanText = result.text;
        removedForwarded = result.removed;
      }

      // Step 2: Remove quoted content
      if (opts.removeQuotes) {
        const result = this.removeQuotedContent(cleanText);
        cleanText = result.text;
        removedQuotes = result.linesRemoved;
      }

      // Step 3: Remove signature
      if (opts.removeSignatures) {
        const result = this.removeSignature(cleanText, opts.maxSignatureLines);
        cleanText = result.text;
        removedSignature = result.removed;
      }

      // Step 4: Clean up whitespace
      cleanText = this.cleanWhitespace(cleanText);

      // Step 5: Remove empty lines at start/end
      cleanText = cleanText.trim();

    } catch (error) {
      logger.error('Error cleaning content:', error);
      // Return original on error
      cleanText = text;
    }

    return {
      cleanText,
      originalText: text,
      removedQuotes,
      removedSignature,
      removedForwarded,
    };
  }

  /**
   * Remove quoted content
   */
  private removeQuotedContent(text: string): { text: string; linesRemoved: number } {
    const lines = text.split('\n');
    const cleanLines: string[] = [];
    let linesRemoved = 0;
    let inQuoteBlock = false;

    for (const line of lines) {
      // Check if line is a quote
      const isQuote = this.isQuoteLine(line);

      if (isQuote) {
        linesRemoved++;
        inQuoteBlock = true;
        continue;
      }

      // If we just left a quote block, add a separator
      if (inQuoteBlock && line.trim() !== '') {
        inQuoteBlock = false;
      }

      cleanLines.push(line);
    }

    return {
      text: cleanLines.join('\n'),
      linesRemoved,
    };
  }

  /**
   * Check if a line is a quote
   */
  private isQuoteLine(line: string): boolean {
    // Check against all quote patterns
    for (const pattern of QUOTE_PATTERNS) {
      if (pattern.test(line)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Remove signature
   */
  private removeSignature(text: string, maxSignatureLines: number): { text: string; removed: boolean } {
    const lines = text.split('\n');
    let signatureStartIndex = -1;

    // Look for signature markers
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - maxSignatureLines - 5); i--) {
      const line = lines[i].trim();

      // Check against signature patterns
      for (const pattern of SIGNATURE_PATTERNS) {
        if (pattern.test(line)) {
          signatureStartIndex = i;
          break;
        }
      }

      if (signatureStartIndex !== -1) {
        break;
      }
    }

    // If signature found, remove it and everything after
    if (signatureStartIndex !== -1) {
      const cleanLines = lines.slice(0, signatureStartIndex);
      return {
        text: cleanLines.join('\n'),
        removed: true,
      };
    }

    // Try heuristic detection
    const heuristicResult = this.detectSignatureHeuristic(lines, maxSignatureLines);
    if (heuristicResult.found) {
      return {
        text: lines.slice(0, heuristicResult.index).join('\n'),
        removed: true,
      };
    }

    return {
      text,
      removed: false,
    };
  }

  /**
   * Detect signature using heuristics
   */
  private detectSignatureHeuristic(lines: string[], maxSignatureLines: number): { found: boolean; index: number } {
    // Look for patterns in the last N lines
    const searchStart = Math.max(0, lines.length - maxSignatureLines - 2);

    for (let i = lines.length - 1; i >= searchStart; i--) {
      const line = lines[i].trim();

      // Look for common signature indicators:
      // 1. Lines with contact info (phone, email)
      // 2. Lines with job titles
      // 3. Short lines followed by blank lines at the end
      if (
        /\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(line) ||              // Phone number
        /@[\w.-]+\.[a-z]{2,}/i.test(line) ||                       // Email
        /(CEO|CTO|VP|Director|Manager|Engineer|Developer)/i.test(line) // Job title
      ) {
        // Check if there are only a few lines after this
        const linesAfter = lines.length - i;
        if (linesAfter <= maxSignatureLines) {
          return { found: true, index: i };
        }
      }
    }

    return { found: false, index: -1 };
  }

  /**
   * Remove forwarded content
   */
  private removeForwardedContent(text: string): { text: string; removed: boolean } {
    let cleanText = text;
    let removed = false;

    // Check for forwarded message markers
    for (const pattern of FORWARDED_PATTERNS) {
      const match = cleanText.search(pattern);
      if (match !== -1) {
        // Remove everything from the forwarded marker onwards
        cleanText = cleanText.substring(0, match).trim();
        removed = true;
        break;
      }
    }

    return { text: cleanText, removed };
  }

  /**
   * Clean excessive whitespace
   */
  private cleanWhitespace(text: string): string {
    return text
      // Replace multiple spaces with single space
      .replace(/ {2,}/g, ' ')
      // Replace multiple newlines with double newline
      .replace(/\n{3,}/g, '\n\n')
      // Remove trailing whitespace from each line
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n');
  }

  /**
   * Extract only the newest message from a reply chain
   */
  extractNewestMessage(text: string): string {
    const cleaned = this.clean(text, {
      removeQuotes: true,
      removeSignatures: true,
      removeForwardedContent: true,
    });

    return cleaned.cleanText;
  }

  /**
   * Split email into message and reply chain
   */
  splitMessageAndReply(text: string): { message: string; replyChain: string } {
    const lines = text.split('\n');
    let splitIndex = lines.length;

    // Find where the reply chain starts
    for (let i = 0; i < lines.length; i++) {
      if (this.isQuoteLine(lines[i])) {
        splitIndex = i;
        break;
      }
    }

    return {
      message: lines.slice(0, splitIndex).join('\n').trim(),
      replyChain: lines.slice(splitIndex).join('\n').trim(),
    };
  }

  /**
   * Check if text contains quoted content
   */
  hasQuotedContent(text: string): boolean {
    const lines = text.split('\n');
    return lines.some(line => this.isQuoteLine(line));
  }

  /**
   * Check if text contains signature
   */
  hasSignature(text: string): boolean {
    const lines = text.split('\n');
    const lastLines = lines.slice(-15); // Check last 15 lines

    return lastLines.some(line => {
      for (const pattern of SIGNATURE_PATTERNS) {
        if (pattern.test(line)) {
          return true;
        }
      }
      return false;
    });
  }
}

/**
 * Default cleaner instance
 */
export const contentCleaner = new ContentCleaner();

/**
 * Clean email content (convenience function)
 */
export function cleanEmailContent(text: string, options?: CleaningOptions): CleanedContent {
  return contentCleaner.clean(text, options);
}
