/**
 * HTML to plain text for an LLM prompt — the thread summary's input.
 *
 * Its own module (moved unchanged from the retired whole-thread extraction
 * pipeline) so the thread summary imports one function, not a pipeline.
 */
import { registerImage } from './image-cache';

/**
 * Compress HTML to plain text + light structure for the Phase 1
 * splitter LLM. Walks the DOM, drops images/styles/scripts/heads, then
 * flattens the tree to plain text with `> ` prefixes for blockquote
 * indentation. Output is typically 5-10x smaller than the cleaned
 * HTML for typical Outlook/Gmail bodies, which lets the prompt fit
 * comfortably in small-context models (gemma-4 with 16K limit) while
 * preserving every sender's words verbatim.
 *
 * Quoted/forwarded structure is PRESERVED via "> " prefixes, "On X
 * wrote:" attributions, and "From:/Sent:/To:" header blocks — the
 * LLM uses these to find message boundaries. We only DROP visual
 * chrome (CSS, font tags, table-based signatures, tracking pixels,
 * MSO conditional comments).
 *
 * Tested with both gpt-oss-120b and sarv-mati-flash via
 * scripts/phase1-prompt-test/ — both score GOOD on the canonical
 * 12-deep VAPT thread fixture using the V3 prompt with this body
 * compression.
 */
export function compressHtmlToPlainTextForLLM(rawBody: string): string {
  if (!rawBody) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawBody, 'text/html');

  // Strip MSO conditionals before any DOM walk — they break parsers.
  const html = doc.documentElement.outerHTML.replace(/<!--\[if[\s\S]{0,4096}?<!\[endif\]-->/gi, '');
  const doc2 = parser.parseFromString(html, 'text/html');

  // Drop noise.
  doc2.querySelectorAll('style, script, head, meta, link, title, noscript').forEach(el => el.remove());
  // Image handling: drop tracking pixels (≤2px or known tracker URL),
  // drop signature logos (small + inside small parents). For genuine
  // content images, replace base64 src with a content-hash ref via the
  // image cache so the LLM gets a tiny placeholder instead of kilobytes
  // of base64. The LLM is instructed to preserve refs verbatim.
  doc2.querySelectorAll('img').forEach(el => {
    const src = el.getAttribute('src') || '';
    const w = parseInt(el.getAttribute('width') || '0', 10);
    const h = parseInt(el.getAttribute('height') || '0', 10);
    const tinyAttr = (w > 0 && w <= 2) || (h > 0 && h <= 2);
    const trackerSrc = /track\.|\/o\/\?|\/open\?|\/pixel|\/tracking|\/beacon|\/__track|sendclean|hs-analytics|mailchimp\.com\/track|sendgrid\.net\/wf|mailgun.*\/o\/|salesforce\.com\/servlet\/servlet\.ImageServer/i.test(src);
    if (tinyAttr || trackerSrc || !src) {
      el.remove();
      return;
    }
    if (src.startsWith('data:image/')) {
      // Lazy import to avoid pulling cache module into every code path.
      const ref = registerImage(src);
      const placeholder = doc2.createTextNode(` ![](${ref}) `);
      el.parentNode?.replaceChild(placeholder, el);
    } else {
      // External http(s) image — keep markdown ref so the LLM sees the
      // URL (one short line) instead of an opaque <img> we'd lose.
      const placeholder = doc2.createTextNode(` ![](${src}) `);
      el.parentNode?.replaceChild(placeholder, el);
    }
  });
  // Drop signature DOM elements (gmail signature, Apple Mail, etc).
  for (const sel of ['.gmail_signature', '[data-smartmail="gmail_signature"]', 'div.AppleMailSignature', 'div.email-signature', 'table.signature', '.sig']) {
    try { doc2.querySelectorAll(sel).forEach(el => el.remove()); } catch { /* skip */ }
  }
  // Drop maybe-signature divs only if short (< 500 text chars).
  for (const sel of ['#Signature', '#signature', 'div[id*="signature" i]', 'div.signature']) {
    try {
      doc2.querySelectorAll(sel).forEach(el => {
        if ((el.textContent || '').trim().length < 500) el.remove();
      });
    } catch { /* skip */ }
  }

  // Mark blockquote boundaries with sentinel strings, walk text-by-text
  // so we can emit "> " prefixes per quoted line below. The sentinels are
  // NUL-padded ("\x00OPENQ\x00") rather than space-padded: the per-line
  // trim below strips spaces at line boundaries (which made " OPENQ "
  // unfindable and leaked literal OPENQ/CLOSEQ tokens into LLM prompts),
  // while NUL survives trim() and can never occur in parsed HTML content
  // (the HTML parser replaces NUL with U+FFFD), so no false matches.
  doc2.querySelectorAll('blockquote').forEach(el => {
    const open = doc2.createTextNode('\x00OPENQ\x00');
    const close = doc2.createTextNode('\x00CLOSEQ\x00');
    el.parentNode?.insertBefore(open, el);
    el.parentNode?.insertBefore(close, el.nextSibling);
  });

  // Replace <br>/end-of-block tags with newlines so the text reads
  // sensibly when flattened. Cell separator → tab so a flattened
  // table is at least readable as columns.
  let text = doc2.body.innerHTML
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<\/td>/gi, '\t')
    .replace(/<[^>]+>/g, '');

  // Decode entities.
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");

  // Collapse runs of spaces. Trim every line. Collapse 3+ blank lines.
  text = text.replace(/[ \t]+/g, ' ');
  text = text.split('\n').map(l => l.trim()).join('\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  // Walk lines, applying "> " depth from the OPENQ/CLOSEQ markers.
  const lines = text.split('\n');
  const out: string[] = [];
  let depth = 0;
  for (const line of lines) {
    let rest = line;
    while (rest.length > 0) {
      const open = rest.indexOf('\x00OPENQ\x00');
      const close = rest.indexOf('\x00CLOSEQ\x00');
      const next = (open === -1) ? close : (close === -1) ? open : Math.min(open, close);
      if (next === -1) {
        const t = rest.trim();
        if (t) out.push('> '.repeat(depth) + t);
        break;
      }
      const before = rest.slice(0, next).trim();
      if (before) out.push('> '.repeat(depth) + before);
      if (rest.startsWith('\x00OPENQ\x00', next)) {
        depth++;
        rest = rest.slice(next + '\x00OPENQ\x00'.length);
      } else {
        depth = Math.max(0, depth - 1);
        rest = rest.slice(next + '\x00CLOSEQ\x00'.length);
      }
    }
  }
  let result = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  // Strip residual Sarv signature boilerplate.
  result = result
    .replace(/www\.sarv\.com\s*\|\s*\+91-\d{4}-\d{4}-\d{2,}/gi, '')
    .replace(/1800-12345-6001/g, '')
    .replace(/Email Disclaimer\s*[–-]\s*[^:\n]{1,60}:[\s\S]*?explicitly stated\.?/gi, '')
    .replace(/Get\s*Outlook for iOS/gi, '')
    .trim();

  return result;
}
