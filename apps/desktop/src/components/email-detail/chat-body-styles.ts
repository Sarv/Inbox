/**
 * A mail's own stylesheet, written into the mail before the chat view drops it.
 *
 * The chat view renders a designed mail inside a sandboxed frame, and the
 * sanitizer it runs first keeps the mail's BODY and removes every `<style>`
 * element — DOMPurify has removed them unconditionally since 3.x, `ADD_TAGS`
 * or not, and it keeps the CSS as TEXT, so a stylesheet that survives as far as
 * the frame is printed above the message rather than applied to it. The
 * standard view has no such problem: it injects its theme into the mail's own
 * `<head>` and leaves the mail's rules alone, which is why the same message
 * reads correctly there and only there.
 *
 * So the rules are moved onto the elements they match, as `style` attributes,
 * which the frame sanitizer does keep. This is the same transform every
 * newsletter build step runs before sending, applied a second time here because
 * the sender only ran it on the rules they thought mattered.
 */
import { inspectBody } from '@sarv-in/email-chat-view';

/**
 * The width the chat frame gets, for deciding which media queries are live.
 *
 * A responsive template ships its narrow layout inline and puts the wide one
 * behind `@media (min-width:…)` — MJML gives every column an inline
 * `width:100%` and narrows it to its real share in the stylesheet. Nothing here
 * can consult a real viewport, so the frame is treated as the desktop surface
 * it is: anything asking for at least this much applies, anything capped below
 * it does not. Guess low and every column stacks; this is a reading pane, not a
 * phone.
 */
const FRAME_WIDTH_PX = 600;

/** One flattened declaration block: what to set, and on what. */
interface FlatRule {
  selector: string;
  declarations: string;
}

/**
 * Does a media query describe the frame?
 *
 * Only the width axis is answered, because it is the only one a template uses
 * to decide its layout. `print` never applies. A dark-mode query never applies
 * either, deliberately and for the same reason the standard view neutralizes
 * it: the frame inherits the OS colour-scheme preference, so a mail's dark
 * rules would fire while the app is in light mode and render the message on a
 * black card. Anything else — `screen`, `all`, a bare query, an orientation or
 * a feature this does not model — is treated as applying, so an unrecognised
 * condition can only ever leave the mail looking the way the sender's own
 * fallback intended.
 */
export function mediaAppliesToFrame(mediaText: string): boolean {
  const queries = (mediaText || '').split(',');
  return queries.some((query) => {
    const text = query.trim().toLowerCase();
    if (!text) return true;
    if (/\bprint\b/.test(text)) return false;
    if (/prefers-color-scheme\s*:\s*dark/.test(text)) return false;
    for (const [, feature, value] of text.matchAll(/\((m(?:in|ax))-width\s*:\s*(-?[\d.]+)px\)/g)) {
      const px = Number(value);
      if (!Number.isFinite(px)) continue;
      if (feature === 'min' && px > FRAME_WIDTH_PX) return false;
      if (feature === 'max' && px < FRAME_WIDTH_PX) return false;
    }
    return true;
  });
}

function isStyleRule(rule: CSSRule): rule is CSSStyleRule {
  return 'selectorText' in rule && 'style' in rule;
}

function isMediaRule(rule: CSSRule): rule is CSSMediaRule {
  return 'media' in rule && 'cssRules' in rule;
}

/** Flatten a rule list into selector/declaration pairs, in source order. */
function collectRules(rules: CSSRuleList, into: FlatRule[]): void {
  for (const rule of Array.from(rules)) {
    if (isStyleRule(rule)) {
      // Trailing `;` trimmed so the blocks can be joined with one of their own.
      const declarations = rule.style.cssText.trim().replace(/;$/, '');
      if (declarations) into.push({ selector: rule.selectorText, declarations });
      continue;
    }
    // Everything else — @font-face, @import, @keyframes — describes a resource
    // or an animation rather than an element, and has nothing to inline.
    if (isMediaRule(rule) && mediaAppliesToFrame(rule.media.mediaText)) {
      collectRules(rule.cssRules, into);
    }
  }
}

/**
 * The browser's own reading of a stylesheet.
 *
 * Parked in the live document because a `<style>` in a document built by
 * `DOMParser` has no `sheet` at all — that document has no browsing context, so
 * nothing ever parses its CSS. `media="not all"` means the rules can never
 * apply to the app while they sit there, and the element is gone again before
 * this returns.
 */
function readStylesheet(css: string): FlatRule[] {
  if (typeof document === 'undefined' || !document.head) return [];
  const carrier = document.createElement('style');
  carrier.media = 'not all';
  carrier.textContent = css;
  document.head.appendChild(carrier);
  const rules: FlatRule[] = [];
  try {
    const sheet = carrier.sheet;
    if (sheet) collectRules(sheet.cssRules, rules);
  } catch {
    // A stylesheet the parser refuses is simply not applied.
  } finally {
    carrier.remove();
  }
  return rules;
}

/** The parser the renderer and the test DOM both provide; absent in Node. */
function parseDocument(html: string): Document | null {
  if (typeof DOMParser === 'undefined') return null;
  try {
    return new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return null;
  }
}

/**
 * Write a mail's stylesheet onto its own elements and return its body.
 *
 * Losing that stylesheet is not a cosmetic downgrade, because a modern template
 * does not use it for decoration. MJML — which the Keka/Sarv daily digest is
 * built with — wraps every column in a `<td style="font-size:0px">` to kill
 * inline-block whitespace and puts the real font sizes in classes. Drop the
 * stylesheet and every element sized that way inherits 0px and disappears: the
 * digest reached the chat view with its greeting, its section headings and its
 * footer copy gone, its header and app-badge rows stacked one item per line,
 * and an avatar's two initials broken onto two lines.
 *
 * Rules are applied in source order and the element's OWN inline styles are
 * re-appended last, so what the sender wrote on the element still wins — the
 * order a browser would have used, minus specificity. Known gap: a later, less
 * specific rule therefore beats an earlier, more specific one. Templates of
 * this kind are written as one flat class per element, so it does not arise;
 * mail that depends on specificity ordering will lose the finer of the two.
 *
 * Returns `html` untouched whenever there is nothing to do — no `<style>` at
 * all, no parser, or a body the chat view will render inline rather than frame
 * (that sanitizer drops `style` attributes too, so inlining would buy nothing
 * and cost a parse).
 *
 * @param conversational the view's own reading of the thread — has more than
 *        one person written in it — which is what decides whether a bare layout
 *        table counts as design. Passed in rather than guessed so this and the
 *        render agree about which bodies end up in a frame.
 */
export function inlineDocumentStyles(html: string, conversational = false): string {
  if (!html || !html.includes('<style')) return html;
  if (inspectBody(html, { conversational }).kind !== 'rich') return html;

  const doc = parseDocument(html);
  const body = doc?.body;
  if (!doc || !body) return html;

  const styleElements = Array.from(doc.querySelectorAll('style'));
  if (styleElements.length === 0) return html;

  const rules = readStylesheet(styleElements.map((element) => element.textContent ?? '').join('\n'));
  // The elements go whether or not a single rule could be read: left in place
  // the sanitizer unwraps them and prints the CSS as text above the message.
  for (const element of styleElements) element.remove();

  const ownStyle = new Map<Element, string>();
  const fromRules = new Map<Element, string>();
  for (const { selector, declarations } of rules) {
    let matches: Element[];
    try {
      matches = Array.from(doc.querySelectorAll(selector));
    } catch {
      // A selector this browser cannot parse matches nothing, as it would have
      // in the sender's own stylesheet.
      continue;
    }
    for (const element of matches) {
      // Snapshotted before anything is written, so the element's own styles can
      // go back on the end no matter how many rules touch it.
      if (!ownStyle.has(element)) ownStyle.set(element, element.getAttribute('style') ?? '');
      const applied = fromRules.get(element);
      fromRules.set(element, applied ? `${applied};${declarations}` : declarations);
    }
  }

  for (const [element, declarations] of fromRules) {
    const own = ownStyle.get(element) ?? '';
    element.setAttribute('style', own ? `${declarations};${own}` : declarations);
  }

  return body.innerHTML;
}
