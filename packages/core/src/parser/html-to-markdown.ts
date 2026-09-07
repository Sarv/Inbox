// HTML to Markdown converter for email content

import TurndownService from 'turndown';

import { logger } from '../utils/logger';

/**
 * HTML to Markdown converter options
 */
export interface HtmlToMarkdownOptions {
  preserveNewlines?: boolean;
  bulletListMarker?: '-' | '*' | '+';
  codeBlockStyle?: 'indented' | 'fenced';
  emDelimiter?: '_' | '*';
  fence?: '```' | '~~~';
  headingStyle?: 'setext' | 'atx';
  hr?: '* * *' | '- - -' | '___';
  linkStyle?: 'inlined' | 'referenced';
  strongDelimiter?: '**' | '__';
}

/**
 * HTML to Markdown Converter
 */
export class HtmlToMarkdown {
  private turndown: TurndownService;

  constructor(options: HtmlToMarkdownOptions = {}) {
    // Initialize Turndown with options
    this.turndown = new TurndownService({
      headingStyle: options.headingStyle || 'atx',
      hr: options.hr || '---',
      bulletListMarker: options.bulletListMarker || '-',
      codeBlockStyle: options.codeBlockStyle || 'fenced',
      fence: options.fence || '```',
      emDelimiter: options.emDelimiter || '_',
      strongDelimiter: options.strongDelimiter || '**',
      linkStyle: options.linkStyle || 'inlined',
      linkReferenceStyle: 'full',
      br: '\n',
    });

    // Add custom rules for email-specific elements
    this.addEmailRules();
  }

  /**
   * Convert HTML to Markdown
   */
  convert(html: string): string {
    try {
      if (!html || html.trim() === '') {
        return '';
      }

      // Pre-process HTML
      const preprocessed = this.preprocessHtml(html);

      // Convert to Markdown
      const markdown = this.turndown.turndown(preprocessed);

      // Post-process Markdown
      return this.postprocessMarkdown(markdown);
    } catch (error) {
      logger.error('Error converting HTML to Markdown:', error);
      // Return plain text version as fallback
      return this.stripHtml(html);
    }
  }

  /**
   * Pre-process HTML before conversion
   */
  private preprocessHtml(html: string): string {
    let processed = html;

    // Replace non-breaking spaces with regular spaces
    processed = processed.replace(/&nbsp;/g, ' ');

    // Replace multiple <br> tags with paragraph breaks
    processed = processed.replace(/(<br\s*\/?>\s*){2,}/gi, '</p><p>');

    // NOTE: no per-line <p> wrapping here — Turndown handles loose text,
    // and wrapping every line of HTML source mangled multi-line tags
    // (attribute continuation lines) and <pre> content.

    // Remove style and script tags
    processed = processed.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    processed = processed.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

    // Remove HTML comments
    processed = processed.replace(/<!--[\s\S]*?-->/g, '');

    return processed;
  }

  /**
   * Post-process Markdown after conversion
   */
  private postprocessMarkdown(markdown: string): string {
    let processed = markdown;

    // Remove excessive blank lines (more than 2 consecutive)
    processed = processed.replace(/\n{3,}/g, '\n\n');

    // Trim leading/trailing whitespace
    processed = processed.trim();

    // Normalize list formatting
    processed = this.normalizeListFormatting(processed);

    // Fix common formatting issues
    processed = this.fixCommonIssues(processed);

    return processed;
  }

  /**
   * Normalize list formatting
   */
  private normalizeListFormatting(markdown: string): string {
    const lines = markdown.split('\n');
    const normalized: string[] = [];
    let inList = false;

    for (const line of lines) {
      const isListItem = /^[\s]*[-*+]\s/.test(line);

      // Add blank line before list starts
      if (isListItem && !inList && normalized.length > 0) {
        const lastLine = normalized[normalized.length - 1];
        if (lastLine.trim() !== '') {
          normalized.push('');
        }
      }

      normalized.push(line);
      inList = isListItem;
    }

    return normalized.join('\n');
  }

  /**
   * Fix common Markdown conversion issues
   */
  private fixCommonIssues(markdown: string): string {
    let fixed = markdown;

    // Fix escaped underscores in words. `_` is never a list marker, so this is
    // always safe to unescape.
    fixed = fixed.replace(/\\_/g, '_');

    // Unescape the bullet-marker characters. Turndown escapes `-`, `*` and `+`
    // wherever they could be misread as Markdown, which for email text is
    // mostly inside ordinary prose: hyphenated words, "a - b", "2 * 3". Only
    // `-` and `*` were handled before, and `*` unconditionally:
    //   - `\-` was never unescaped at all, so every hyphen Turndown touched
    //     reached the reader (and the LLM prompt) as a literal `\-`;
    //   - unescaping `*` at the START of a line turned prose into a bullet.
    // Unescape everywhere EXCEPT where the backslash is load-bearing.
    fixed = HtmlToMarkdown.unescapeBulletChars(fixed);

    // Fix link formatting issues
    fixed = fixed.replace(/\[\s+/g, '[');
    fixed = fixed.replace(/\s+\]/g, ']');

    // Remove extra backslashes before common punctuation
    fixed = fixed.replace(/\\([.,;:!?])/g, '$1');

    return fixed;
  }

  /**
   * Unescape `\-`, `\*` and `\+`, keeping the backslash only where dropping it
   * would CREATE Markdown: at the start of a line and followed by whitespace,
   * which is exactly a bullet marker. Static + pure so it can be unit-tested
   * against the shapes that matter without building a converter.
   */
  static unescapeBulletChars(text: string): string {
    return text.replace(/\\([-*+])/g, (match, char: string, offset: number) => {
      const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
      const atLineStart = text.slice(lineStart, offset).trim() === '';
      const next = text[offset + 2];
      const wouldBecomeBullet = atLineStart && (next === undefined || /\s/.test(next));
      return wouldBecomeBullet ? match : char;
    });
  }

  /**
   * Strip HTML tags (fallback for errors)
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }

  /**
   * Add custom rules for email-specific elements
   */
  private addEmailRules(): void {
    // Rule for blockquote styling (common in email replies)
    this.turndown.addRule('emailBlockquote', {
      filter: 'blockquote',
      replacement: (content) => {
        // Split by lines and prefix each with >
        return content
          .split('\n')
          .map(line => `> ${line}`)
          .join('\n') + '\n\n';
      },
    });

    // Rule for handling tables
    this.turndown.addRule('emailTable', {
      filter: 'table',
      replacement: (content) => {
        // Simple table conversion (can be enhanced)
        return `\n\n${content}\n\n`;
      },
    });

    // Rule for handling email signatures
    this.turndown.addRule('emailSignature', {
      filter: (node: any) => {
        if (node.nodeName === 'DIV') {
          const className = node.className || '';
          const id = node.id || '';
          // Common signature markers
          return /signature|sig|gmail_signature/.test(className + id);
        }
        return false;
      },
      replacement: (content) => {
        return `\n\n---\n${content}\n`;
      },
    });

    // Rule for preserving email addresses
    this.turndown.addRule('emailAddress', {
      filter: (node: any) => {
        if (node.nodeName === 'A') {
          const href = node.getAttribute('href') || '';
          return href.startsWith('mailto:');
        }
        return false;
      },
      replacement: (content, node) => {
        const href = (node as any).getAttribute('href') || '';
        const email = href.replace('mailto:', '');
        return content === email ? email : `${content} <${email}>`;
      },
    });

    // Rule for handling horizontal rules
    this.turndown.addRule('horizontalRule', {
      filter: 'hr',
      replacement: () => '\n\n---\n\n',
    });
  }
}

/**
 * Default converter instance
 */
export const htmlToMarkdown = new HtmlToMarkdown({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
  emDelimiter: '_',
  strongDelimiter: '**',
  linkStyle: 'inlined',
  hr: '* * *',
});

/**
 * Convert HTML to Markdown (convenience function)
 */
export function convertHtmlToMarkdown(html: string, options?: HtmlToMarkdownOptions): string {
  if (options) {
    const converter = new HtmlToMarkdown(options);
    return converter.convert(html);
  }
  return htmlToMarkdown.convert(html);
}
