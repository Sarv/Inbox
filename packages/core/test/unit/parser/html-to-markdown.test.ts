import { describe, expect, it } from 'vitest';

import { HtmlToMarkdown, convertHtmlToMarkdown, htmlToMarkdown } from '../../../src/parser/html-to-markdown';

// HTML→Markdown is what turns a marketing/reply email body into the compact text
// the LLM and the chat view read. The invariants: real content survives, the
// noise turndown would otherwise inline (style/script/comments) is stripped
// first, email-specific shapes (reply blockquotes, mailto links, signature
// blocks) get their intended markdown, and a converter failure degrades to plain
// text instead of throwing.

const converter = new HtmlToMarkdown();

describe('HtmlToMarkdown.convert — basics', () => {
  it('returns an empty string for empty/blank input', () => {
    expect(converter.convert('')).toBe('');
    expect(converter.convert('   \n ')).toBe('');
    expect(converter.convert(undefined as unknown as string)).toBe('');
  });

  it('converts headings, emphasis, links and lists', () => {
    const md = converter.convert(
      '<h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em> text.</p>' +
      '<ul><li>first</li><li>second</li></ul>' +
      '<a href="https://x.example">link</a>',
    );
    expect(md).toContain('# Title');            // atx heading style
    expect(md).toContain('**bold**');
    expect(md).toContain('_italic_');
    expect(md).toMatch(/-\s+first/);        // turndown pads list markers
    expect(md).toMatch(/-\s+second/);
    expect(md).toContain('[link](https://x.example)');
  });

  it('strips style, script and comment noise before converting', () => {
    const md = converter.convert(
      '<style>.a{color:red}</style>' +
      '<script>alert(1)</script>' +
      '<!--[if mso]><p>outlook only</p><![endif]-->' +
      '<p>real content</p>',
    );
    expect(md).toBe('real content');
    expect(md).not.toContain('color:red');
    expect(md).not.toContain('alert');
    expect(md).not.toContain('outlook only');
  });

  it('turns non-breaking spaces into ordinary spaces', () => {
    const md = converter.convert('<p>Tom&nbsp;&amp;&nbsp;Jerry</p>');
    expect(md).toBe('Tom & Jerry');
  });

  it('turns a run of <br> tags into a paragraph break rather than stacked breaks', () => {
    const md = converter.convert('<p>first line<br><br><br>second line</p>');
    expect(md).toContain('first line');
    expect(md).toContain('second line');
    expect(md).not.toMatch(/\n{3,}/);          // excessive blank lines collapsed
  });

  it('collapses more than two consecutive blank lines and trims the result', () => {
    const md = converter.convert('<p>a</p><p>&nbsp;</p><p>&nbsp;</p><p>&nbsp;</p><p>b</p>');
    expect(md.startsWith('a')).toBe(true);
    expect(md.endsWith('b')).toBe(true);
    expect(md).not.toMatch(/\n{3,}/);
  });

  it('inserts a blank line before a list that follows a paragraph of text', () => {
    const md = converter.convert('<div>Intro text<ul><li>one</li></ul></div>');
    expect(md).toMatch(/Intro text\n\n[-*+]\s+one/);
  });

  // A hand-written dash list (plain text, not <ul>) must keep its items on
  // separate lines instead of collapsing into one run-on paragraph. The leading
  // dashes stay ESCAPED: at the start of a line, that backslash is the only
  // thing keeping the sender's own text from being re-read as Markdown.
  it('keeps a hand-written dash list on separate lines', () => {
    const md = converter.convert('<p>Deliverables:\n<br>- first item<br>- second item</p>');
    expect(md).toContain('first item');
    expect(md).toContain('second item');
    expect(md.split('\n').filter(l => l.includes('item'))).toHaveLength(2);
  });

  // Turndown escapes every `-` it thinks could be Markdown, so hyphens inside
  // ordinary prose used to reach the reader (and the LLM prompt) as `\-`:
  // "Q\-3 re\-check". Nothing unescaped `-` at all.
  it('unescapes hyphens that turndown escaped inside prose', () => {
    const md = converter.convert('<p>Q1 - Q3 re-check of the re-order flow</p>');
    expect(md).not.toContain('\\-');
    expect(md).toContain('Q1 - Q3');
    expect(md).toContain('re-check');
  });

  it('unescapes the punctuation turndown escapes in prose', () => {
    const md = converter.convert('<p>snake_case_name and 2*3 stars</p>');
    expect(md).toContain('snake_case_name');    // no backslash-escaped underscores
    expect(md).toContain('2*3');
    expect(md).not.toContain('\\_');
    expect(md).not.toContain('\\*');
  });

  // The unescape is character-level and pure; these are the cases that decide
  // whether dropping a backslash CREATES Markdown that the sender never wrote.
  describe('unescapeBulletChars', () => {
    it('unescapes mid-line, where the char is just text', () => {
      expect(HtmlToMarkdown.unescapeBulletChars('a \\- b')).toBe('a - b');
      expect(HtmlToMarkdown.unescapeBulletChars('2 \\* 3')).toBe('2 * 3');
      expect(HtmlToMarkdown.unescapeBulletChars('a \\+ b')).toBe('a + b');
      expect(HtmlToMarkdown.unescapeBulletChars('re\\-check')).toBe('re-check');
    });

    it('KEEPS the escape where dropping it would create a bullet', () => {
      expect(HtmlToMarkdown.unescapeBulletChars('\\- item')).toBe('\\- item');
      expect(HtmlToMarkdown.unescapeBulletChars('text\n\\* item')).toBe('text\n\\* item');
      expect(HtmlToMarkdown.unescapeBulletChars('  \\+ item')).toBe('  \\+ item');
      // A trailing escaped marker with nothing after it is still a marker.
      expect(HtmlToMarkdown.unescapeBulletChars('\\-')).toBe('\\-');
    });

    it('unescapes at line start when NO whitespace follows — not a bullet', () => {
      expect(HtmlToMarkdown.unescapeBulletChars('\\-5 degrees')).toBe('-5 degrees');
      expect(HtmlToMarkdown.unescapeBulletChars('\\*bold-ish')).toBe('*bold-ish');
    });

    it('leaves text with no escapes untouched', () => {
      expect(HtmlToMarkdown.unescapeBulletChars('- a real list')).toBe('- a real list');
      expect(HtmlToMarkdown.unescapeBulletChars('')).toBe('');
    });
  });

  it('tightens the whitespace turndown can leave inside link labels', () => {
    const md = converter.convert('<p><a href="https://x.example"> spaced label </a></p>');
    expect(md).toContain('[spaced label](https://x.example)');
  });
});

describe('HtmlToMarkdown.convert — email-specific rules', () => {
  it('prefixes a reply blockquote with ">" on every line', () => {
    const md = converter.convert('<blockquote><p>quoted line one</p><p>quoted line two</p></blockquote>');
    const quoted = md.split('\n').filter(l => l.trim() !== '');
    expect(quoted.every(l => l.startsWith('>'))).toBe(true);
    expect(md).toContain('quoted line one');
    expect(md).toContain('quoted line two');
  });

  it('keeps table cell text (tables are flattened, not dropped)', () => {
    const md = converter.convert('<table><tr><td>Item</td><td>42</td></tr></table>');
    expect(md).toContain('Item');
    expect(md).toContain('42');
  });

  it('marks a signature div off with a horizontal rule', () => {
    const md = converter.convert('<p>Body text.</p><div class="gmail_signature">Alice — Acme</div>');
    expect(md).toContain('Body text.');
    expect(md).toContain('---');
    expect(md).toContain('Alice — Acme');
  });

  it('renders a mailto link as the bare address when the label IS the address', () => {
    expect(converter.convert('<a href="mailto:alice@example.com">alice@example.com</a>'))
      .toBe('alice@example.com');
  });

  it('renders a named mailto link as "Name <address>"', () => {
    expect(converter.convert('<a href="mailto:alice@example.com">Alice</a>'))
      .toBe('Alice <alice@example.com>');
  });

  it('renders <hr> as a markdown rule', () => {
    expect(converter.convert('<p>above</p><hr><p>below</p>')).toContain('---');
  });

  it('keeps <pre> content intact instead of reflowing it', () => {
    const md = converter.convert('<pre><code>line1\n  indented\n</code></pre>');
    expect(md).toContain('line1');
    expect(md).toContain('  indented');
  });
});

describe('HtmlToMarkdown.convert — failure fallback', () => {
  // A converter crash must not lose the message: the fallback strips tags and
  // decodes the common entities so the text is still usable.
  it('falls back to stripped plain text when turndown throws', () => {
    const failing = new HtmlToMarkdown();
    (failing as unknown as { turndown: { turndown: () => string } }).turndown.turndown = () => {
      throw new Error('turndown blew up');
    };

    const out = failing.convert('<p>Tom&nbsp;&amp;&nbsp;Jerry said &lt;hi&gt; &quot;now&quot; &#39;ok&#39;</p>');
    expect(out).toBe('Tom & Jerry said <hi> "now" \'ok\'');
    expect(out).not.toContain('<p>');
  });
});

describe('convertHtmlToMarkdown / htmlToMarkdown surface', () => {
  it('the shared instance and the convenience function agree', () => {
    const html = '<p>same <strong>result</strong></p>';
    expect(convertHtmlToMarkdown(html)).toBe(htmlToMarkdown.convert(html));
  });

  it('honours per-call option overrides', () => {
    const html = '<ul><li>item</li></ul><p><em>em</em> <strong>strong</strong></p>';
    const md = convertHtmlToMarkdown(html, {
      bulletListMarker: '*',
      emDelimiter: '*',
      strongDelimiter: '__',
    });
    expect(md).toMatch(/\*\s+item/);
    expect(md).toContain('*em*');
    expect(md).toContain('__strong__');
  });

  it('honours setext headings, indented code and referenced links when asked', () => {
    const md = convertHtmlToMarkdown(
      '<h1>Heading</h1><pre><code>code()</code></pre><p><a href="https://x.example">label</a></p>',
      { headingStyle: 'setext', codeBlockStyle: 'indented', linkStyle: 'referenced' },
    );
    expect(md).toContain('Heading\n=======');   // setext underline, not "# "
    expect(md).toContain('    code()');         // indented code block
    expect(md).toMatch(/\[label\]\[\d\]/);      // reference-style link
    expect(md).toContain('https://x.example');
  });

  it('honours a fenced code block with a custom fence', () => {
    const md = convertHtmlToMarkdown('<pre><code>code()</code></pre>', { codeBlockStyle: 'fenced', fence: '~~~' });
    expect(md).toContain('~~~');
    expect(md).toContain('code()');
  });
});
