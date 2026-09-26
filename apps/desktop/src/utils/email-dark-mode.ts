/**
 * Dark mode for the message body itself.
 *
 * The reading pane renders received mail on a forced WHITE canvas, because that
 * is the page the sender wrote it for: email HTML is only ever partially
 * styled, so dropping a dark background behind it turns every element the
 * sender did not colour dark while everything they did colour stays as
 * authored — black-on-black body copy next to a bright white logo island. That
 * behaviour is the default and is what everyone keeps.
 *
 * This module is the opt-in alternative (Appearance → "Dark email bodies"). It
 * does what Apple Mail and Outlook do rather than what a blanket
 * `filter: invert()` does: it walks the message, and
 *
 *   • re-colours every colour the sender DECLARED, for a dark page, and
 *   • leaves everything the sender did NOT declare to the frame's own theme,
 *     which is already dark.
 *
 * Two things make the result readable rather than merely inverted:
 *
 *   1. **Surfaces are classified, not flipped.** A near-white page or a pale
 *      tint is paper — it flips. A saturated brand colour (a red CTA, a blue
 *      header bar) is the sender's identity and an already-dark block needs no
 *      help, so both are KEPT.
 *   2. **Text is re-coloured against the surface it actually sits on.** The
 *      walk carries that surface down the tree, so `color:#fff` inside a red
 *      button is left alone (the button is still red) while `color:#333` on the
 *      page is lifted to a light grey. Flipping every declared colour
 *      independently is exactly what produces grey-on-red buttons.
 *
 * Nothing here is regex-driven: the HTML goes through `DOMParser` (the
 * browser's own parser), declarations through `postcss`, values through
 * `postcss-value-parser`, and every colour through `culori`, which knows every
 * CSS colour syntax including the 148 named ones. The one lossy step is
 * documented at `serializeDeclarations`.
 *
 * Pure and DOM-boundary-only on purpose — `SandboxedEmailBody` is the only
 * caller and it passes strings in and gets strings out.
 */
import { clampChroma, converter, formatRgb, parse as parseColor, type Oklch } from 'culori';
import postcss, { type ChildNode, type Declaration } from 'postcss';
import valueParser from 'postcss-value-parser';

/** What a colour is being used FOR, which is what decides how it moves. */
export type ColorRole = 'text' | 'surface' | 'line' | 'shadow';

/**
 * The page under the content being re-coloured.
 *
 * `inverted` — it was light and we turned it dark, so the text on it has to
 * come with us. `kept` — it is a brand colour or was already dark, so it still
 * looks the way the sender drew it and the text on it must not be touched.
 */
export type Surface = 'inverted' | 'kept';

export interface EmailDarkResult {
  /** The message HTML, re-coloured when that is what the strategy called for. */
  html: string;
  /** True when the frame should drop its forced white canvas and go dark. */
  darkCanvas: boolean;
  /** Which branch ran — exposed so the tests can assert the DECISION, not just its colours. */
  strategy: EmailDarkStrategy;
}

/**
 * - `off`      — the white canvas, unchanged. Setting disabled, app in light
 *                theme, no DOM to parse with, or a message too large to walk.
 * - `preserve` — the message is ALREADY dark by design. Dark canvas, colours
 *                untouched; re-colouring it would turn it light.
 * - `invert`   — the message was written for a white page. Re-colour it.
 */
export type EmailDarkStrategy = 'off' | 'preserve' | 'invert';

const toOklch = converter('oklch');

/**
 * Above this OKLCH chroma a colour reads as a colour rather than a grey. Pale
 * tints (`#f4f7ff`) sit below it, which is what keeps a tinted card counted as
 * paper instead of as branding.
 */
const NEUTRAL_CHROMA = 0.045;

/** At or above this OKLCH lightness even a saturated colour is a pale wash — a
 *  highlight band, a zebra row — and belongs to the page, not the brand. */
const TINT_LIGHTNESS = 0.82;

/** At or below this, a surface is already dark enough to leave alone. */
const ALREADY_DARK = 0.45;

/** White becomes this; black becomes SURFACE_MAX. Between them the mapping is
 *  linear, so the sender's ordering of surfaces survives the flip — a card
 *  lighter than its page stays lighter than its page.
 *
 *  SURFACE_MIN is the app's own dark reading surface (OKLCH L 0.14 for
 *  `--background`) rounded up a notch, so a white message sits just ABOVE the
 *  chrome around it rather than punching a blacker hole in the middle of it. */
const SURFACE_MIN = 0.18;
const SURFACE_MAX = 0.34;

/** A rule on an inverted surface lands in this band. The floor is the app's own
 *  `--border` (OKLCH L 0.28): anything dimmer than the borders the rest of the
 *  window draws is a divider the reader cannot see. */
const LINE_MIN = 0.3;
const LINE_MAX = 0.46;

/** Black text becomes this; white text becomes TEXT_MIN. Linear in between for
 *  the same reason: #999 must stay dimmer than #333 or every muted caption
 *  comes back as body copy. Pure white is deliberately out of reach — maximum
 *  glare is the thing dark mode is turned on to avoid. */
const TEXT_MAX = 0.93;
const TEXT_MIN = 0.62;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

/** Colour functions whose whole call is one colour — parsed as a unit, never descended into. */
const COLOR_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
]);

/**
 * Functions to step over entirely: whatever is inside them is not a colour.
 *
 * `var()` is deliberately NOT here. It is not a colour either, but its fallback
 * argument is, and that fallback is what actually paints — see `darkenValue`.
 */
const OPAQUE_FUNCTIONS = new Set(['url', 'attr', 'counter', 'counters', 'format', 'local']);

/**
 * Which properties carry a colour, and what that colour is for.
 *
 * Shorthands are here too (`border`, `background`, `outline`): the value walker
 * only touches the parts of a value that parse as a colour, so `1px solid #ccc`
 * keeps its width and its style.
 */
const PROPERTY_ROLES: ReadonlyMap<string, ColorRole> = new Map<string, ColorRole>([
  ['color', 'text'],
  ['-webkit-text-fill-color', 'text'],
  ['caret-color', 'text'],
  ['text-decoration-color', 'text'],
  ['text-emphasis-color', 'text'],
  ['fill', 'text'],
  ['background', 'surface'],
  ['background-color', 'surface'],
  ['background-image', 'surface'],
  ['border', 'line'],
  ['border-top', 'line'],
  ['border-right', 'line'],
  ['border-bottom', 'line'],
  ['border-left', 'line'],
  ['border-color', 'line'],
  ['border-top-color', 'line'],
  ['border-right-color', 'line'],
  ['border-bottom-color', 'line'],
  ['border-left-color', 'line'],
  ['outline', 'line'],
  ['outline-color', 'line'],
  ['column-rule', 'line'],
  ['column-rule-color', 'line'],
  ['stroke', 'line'],
  ['box-shadow', 'shadow'],
  ['text-shadow', 'shadow'],
]);

/** The HTML4 presentational colour attributes, which designed mail still ships. */
const ATTRIBUTE_ROLES: ReadonlyMap<string, ColorRole> = new Map<string, ColorRole>([
  ['bgcolor', 'surface'],
  ['color', 'text'],
  ['text', 'text'],
  ['link', 'text'],
  ['vlink', 'text'],
  ['alink', 'text'],
  ['bordercolor', 'line'],
]);

/**
 * Walking a document costs a DOMParser parse plus a visit per element. Past
 * this many elements the cost stops being invisible on the render thread, and a
 * message that renders exactly as it does today (on white) is a far better
 * outcome than a reading pane that stalls when it opens.
 */
const MAX_ELEMENTS = 15000;

/** Cheap pre-filter: a style attribute with no colour-bearing property in it is
 *  the common case (padding, width, font-size) and never reaches postcss. */
const MENTIONS_COLOR = /color|background|border|outline|shadow|fill|stroke/i;

const roleOf = (property: string): ColorRole | undefined =>
  PROPERTY_ROLES.get(property.trim().toLowerCase());

/** sRGB-safe serialization. OKLCH can express colours no display has, and an
 *  out-of-gamut value formats to a channel outside 0-255; clamp first. */
const formatColor = (color: Oklch): string => formatRgb(clampChroma(color, 'oklch'));

/** A surface colour → what it becomes, and what that means for the text on it. */
export const darkenSurfaceColor = (color: Oklch): { color: Oklch; surface: Surface } => {
  const chroma = color.c ?? 0;
  // Already dark: the sender drew this for a dark block (a footer, a hero) and
  // it still works. Flipping it would turn it LIGHT, which is the opposite of
  // what was asked for, and would drag its white text down with it.
  if (color.l <= ALREADY_DARK) return { color, surface: 'kept' };
  // A saturated mid-tone is branding — a CTA, a coloured header bar. Keep the
  // hue and the chroma; only pull back a brightness that would glare.
  if (chroma > NEUTRAL_CHROMA && color.l < TINT_LIGHTNESS) {
    return { color: { ...color, l: Math.min(color.l, 0.58) }, surface: 'kept' };
  }
  // Paper. Flip it, keeping a trace of any tint so a pale yellow band comes
  // back as a dark yellow band rather than as another grey one.
  return {
    color: {
      ...color,
      l: SURFACE_MIN + (1 - color.l) * (SURFACE_MAX - SURFACE_MIN),
      c: Math.min(chroma, 0.06),
    },
    surface: 'inverted',
  };
};

/** A text colour on a surface we inverted. */
export const darkenTextColor = (color: Oklch): Oklch => {
  const chroma = color.c ?? 0;
  if (chroma <= NEUTRAL_CHROMA) {
    return { ...color, l: TEXT_MAX - color.l * (TEXT_MAX - TEXT_MIN) };
  }
  // A coloured link or heading keeps its hue and only has to become light
  // enough to read; full saturation at high lightness vibrates on near-black.
  return { ...color, l: Math.max(color.l, 0.72), c: Math.min(chroma, 0.15) };
};

/** A rule or border colour on a surface we inverted. */
export const darkenLineColor = (color: Oklch): Oklch => {
  if (color.l <= ALREADY_DARK) return color;
  return { ...color, l: clamp(1 - color.l, LINE_MIN, LINE_MAX), c: Math.min(color.c ?? 0, 0.08) };
};

/** A shadow on a surface we inverted: shadows on a dark page are darker, never lighter. */
export const darkenShadowColor = (color: Oklch): Oklch => ({ ...color, l: Math.min(color.l, 0.2) });

/**
 * One colour token → its dark-mode counterpart, or null when it should not move.
 *
 * Returns null (rather than the same string) for anything that is not a colour,
 * is fully transparent, or sits on a surface the sender still owns — so callers
 * can tell "unchanged" from "changed to the same thing" and leave the original
 * text in place byte-for-byte.
 */
export const darkenColorToken = (
  token: string,
  role: ColorRole,
  surface: Surface,
): string | null => {
  const parsed = parseColor(token);
  if (!parsed) return null;
  const color = toOklch(parsed);
  if (!color) return null;
  // Fully transparent carries no colour; re-colouring it only makes the markup
  // noisier and can defeat a `background: transparent` reset.
  if (color.alpha === 0) return null;

  if (role === 'surface') {
    const next = darkenSurfaceColor(color);
    return next.surface === 'kept' && next.color === color ? null : formatColor(next.color);
  }
  // Everything else is drawn ON a surface. If that surface still looks the way
  // the sender drew it, so must what sits on it.
  if (surface === 'kept') return null;
  if (role === 'text') return formatColor(darkenTextColor(color));
  if (role === 'line') return formatColor(darkenLineColor(color));
  return formatColor(darkenShadowColor(color));
};

/**
 * The paper a re-coloured message is drawn on: what a white page becomes.
 *
 * Derived from the surface mapping rather than written out, so the frame's
 * canvas can never drift away from the colour the message's OWN white
 * backgrounds land on. Without that agreement a `background: white` on a
 * paragraph paints a visible slab against the page around it.
 */
export const DARK_PAPER = darkenColorToken('#ffffff', 'surface', 'inverted') ?? 'rgb(18, 18, 18)';

/**
 * Re-colour every colour inside one declaration VALUE, leaving the rest of the
 * value (lengths, keywords, `url()`s, gradient stop positions) untouched.
 *
 * Returns the surface the value establishes when the role is `surface` — the
 * first colour in it wins, which for `background: #fff url(x.png) no-repeat` is
 * the one that actually paints the box.
 */
export const darkenValue = (
  value: string,
  role: ColorRole,
  surface: Surface,
): { value: string; surface: Surface | null } => {
  let established: Surface | null = null;
  const parsed = valueParser(value);
  let changed = false;

  const apply = (token: string): string | null => {
    if (role === 'surface' && established === null) {
      const color = parseColor(token);
      if (color) {
        const oklch = toOklch(color);
        if (oklch && oklch.alpha !== 0) established = darkenSurfaceColor(oklch).surface;
      }
    }
    return darkenColorToken(token, role, surface);
  };

  const visit = (node: valueParser.Node): void | boolean => {
    if (node.type === 'function') {
      const name = node.value.toLowerCase();
      // A `var()` reference we cannot resolve: the custom property was declared
      // in a stylesheet the frame never loads, so the browser falls back, and
      // the fallback is the colour the reader actually sees. Re-colour inside
      // it and leave the property name — which is not a colour — alone.
      if (name === 'var') {
        const comma = node.nodes.findIndex((arg) => arg.type === 'div' && arg.value === ',');
        if (comma !== -1) valueParser.walk(node.nodes.slice(comma + 1), visit);
        return false;
      }
      if (OPAQUE_FUNCTIONS.has(name)) return false;
      if (!COLOR_FUNCTIONS.has(name)) return undefined;
      const next = apply(valueParser.stringify(node));
      if (next) {
        // Collapse the whole call to a plain token. `nodes` is dropped with it
        // so the stringifier cannot re-emit the arguments after the value.
        const word = node as unknown as valueParser.WordNode & { nodes?: unknown };
        word.type = 'word';
        word.value = next;
        delete word.nodes;
        changed = true;
      }
      return false;
    }
    if (node.type === 'word') {
      const next = apply(node.value);
      if (next) {
        node.value = next;
        changed = true;
      }
    }
    return undefined;
  };

  parsed.walk(visit);

  return { value: changed ? valueParser.stringify(parsed.nodes) : value, surface: established };
};

/**
 * Re-colour a list of declarations, in the two passes the surface rule needs:
 * backgrounds first, so the text in the same block is moved against the surface
 * it will actually be drawn on rather than against the one it inherited.
 *
 * Mutates in place — both callers (a style attribute and a stylesheet rule) own
 * postcss nodes whose other declarations must survive verbatim.
 */
const darkenDeclarationList = (declarations: Declaration[], inherited: Surface): Surface => {
  let surface = inherited;
  for (const declaration of declarations) {
    if (roleOf(declaration.prop) !== 'surface') continue;
    const next = darkenValue(declaration.value, 'surface', surface);
    declaration.value = next.value;
    if (next.surface) surface = next.surface;
  }
  for (const declaration of declarations) {
    const role = roleOf(declaration.prop);
    if (!role || role === 'surface') continue;
    declaration.value = darkenValue(declaration.value, role, surface).value;
  }
  return surface;
};

const declarationsOf = (container: { nodes?: ChildNode[] }): Declaration[] =>
  (container.nodes ?? []).filter((node): node is Declaration => node.type === 'decl');

/**
 * Re-colour one `style="…"` attribute.
 *
 * Returns the rewritten attribute and the surface it establishes for the
 * element's own text and for its children. `null` for anything postcss cannot
 * parse: a half-quoted style attribute is not worth failing a whole message
 * over, and leaving it alone renders it exactly as it does today.
 */
export const darkenStyleAttribute = (
  style: string,
  inherited: Surface,
): { style: string; surface: Surface } | null => {
  if (!MENTIONS_COLOR.test(style)) return null;
  try {
    // postcss parses stylesheets, so the declarations are handed to it as the
    // body of a rule — which is also what keeps `url(data:…;base64,…)` from
    // being split on its semicolons the way a hand-rolled `split(';')` does.
    const root = postcss.parse(`a{${style}}`);
    const rule = root.first;
    if (!rule || rule.type !== 'rule') return null;
    const surface = darkenDeclarationList(declarationsOf(rule), inherited);
    return { style: serializeDeclarations(rule), surface };
  } catch {
    return null;
  }
};

/**
 * Put a rule's declarations back into an inline `style` attribute.
 *
 * LOSSY IN ONE WAY, deliberately: postcss keeps what it could not parse as a
 * raw remainder, and that remainder is dropped here. In practice that is
 * Outlook's `mso-*` and IE's `filter: progid:…`, neither of which does anything
 * in Chromium, and this whole path only runs when the reader has opted into
 * dark bodies.
 */
const serializeDeclarations = (rule: { nodes?: ChildNode[] }): string =>
  declarationsOf(rule)
    .map((node) => `${node.prop}: ${node.value}${node.important ? ' !important' : ''}`)
    .join('; ');

/**
 * Re-colour an embedded `<style>` block.
 *
 * Rules are handled one at a time and each one resolves its OWN surface, so
 * `.btn{background:#d32f2f;color:#fff}` keeps its white-on-red. What a rule
 * cannot know is which elements it lands on, so a rule that sets only a colour
 * is treated as sitting on the page — which it almost always is.
 */
export const darkenStyleSheet = (css: string): string => {
  if (!MENTIONS_COLOR.test(css)) return css;
  try {
    const root = postcss.parse(css);
    root.walkRules((rule) => {
      darkenDeclarationList(declarationsOf(rule), 'inverted');
    });
    return root.toString();
  } catch {
    return css;
  }
};

/** The colour an element declares for its own box, from either source. */
const attributeSurface = (element: Element, inherited: Surface): Surface => {
  const bgcolor = element.getAttribute('bgcolor');
  if (!bgcolor) return inherited;
  const parsed = parseColor(bgcolor.trim());
  if (!parsed) return inherited;
  const color = toOklch(parsed);
  if (!color || color.alpha === 0) return inherited;
  const next = darkenSurfaceColor(color);
  element.setAttribute('bgcolor', formatColor(next.color));
  return next.surface;
};

const darkenAttributes = (element: Element, surface: Surface): void => {
  for (const [name, role] of ATTRIBUTE_ROLES) {
    if (role === 'surface') continue;
    const value = element.getAttribute(name);
    if (!value) continue;
    const next = darkenColorToken(value.trim(), role, surface);
    if (next) element.setAttribute(name, next);
  }
};

/**
 * Walk one element and its subtree, carrying the surface down.
 *
 * Iterative rather than recursive: a mail client's quoted-reply chain nests
 * `<blockquote>` once per reply and a long thread is deep enough that a
 * per-element stack frame is a real risk.
 */
const darkenSubtree = (root: Element): void => {
  const stack: Array<{ element: Element; surface: Surface }> = [
    // The page behind the message is the frame's own dark canvas, so anything
    // the sender left to the browser is already being drawn on a dark surface.
    { element: root, surface: 'inverted' },
  ];
  while (stack.length > 0) {
    const { element, surface } = stack.pop()!;
    const tag = element.tagName.toLowerCase();
    // <style> is re-coloured as a stylesheet, not as an element; nothing inside
    // <script> renders (the sandbox blocks it and the stripper removes it).
    if (tag === 'style' || tag === 'script') continue;

    // bgcolor first so a style attribute that also sets a background still
    // wins — it does in the cascade, and it has to here too.
    let next = attributeSurface(element, surface);
    const style = element.getAttribute('style');
    if (style) {
      const rewritten = darkenStyleAttribute(style, next);
      if (rewritten) {
        element.setAttribute('style', rewritten.style);
        next = rewritten.surface;
      }
    }
    darkenAttributes(element, next);

    const children = element.children;
    for (let index = 0; index < children.length; index += 1) {
      stack.push({ element: children[index]!, surface: next });
    }
  }
};

/** Whether the message already draws itself on a dark page. */
const pageIsAlreadyDark = (body: HTMLElement): boolean => {
  const candidates: Element[] = [body];
  // The classic email shell is a full-width table (or div) immediately inside
  // the body carrying the page colour, with the body itself declaring nothing.
  const first = body.firstElementChild;
  if (first) candidates.push(first);
  for (const element of candidates) {
    const declared = backgroundOf(element);
    if (!declared) continue;
    const color = toOklch(declared);
    if (color && color.alpha !== 0) return color.l <= ALREADY_DARK;
  }
  return false;
};

/** An element's declared background colour, style attribute first. */
const backgroundOf = (element: Element): ReturnType<typeof parseColor> => {
  const style = element.getAttribute('style');
  if (style && MENTIONS_COLOR.test(style)) {
    try {
      const rule = postcss.parse(`a{${style}}`).first;
      if (rule && rule.type === 'rule') {
        for (const declaration of declarationsOf(rule).reverse()) {
          if (roleOf(declaration.prop) !== 'surface') continue;
          for (const node of valueParser(declaration.value).nodes) {
            if (node.type !== 'word' && node.type !== 'function') continue;
            const color = parseColor(valueParser.stringify(node));
            if (color) return color;
          }
        }
      }
    } catch {
      // Unparseable inline style: fall through to the attribute.
    }
  }
  const bgcolor = element.getAttribute('bgcolor');
  return bgcolor ? parseColor(bgcolor.trim()) : undefined;
};

/**
 * Put the walked document back into the same SHAPE it arrived in.
 *
 * `buildSrcdoc` branches on whether the message is a full document, a bare
 * `<body>`, or a fragment, and injects the frame's CSP and stylesheet
 * differently for each. Handing it a different shape than it was given would
 * change where that injection lands — and a document that arrived with a
 * doctype must leave with one, or the frame silently re-renders the whole
 * message in quirks mode.
 */
const serializeDocument = (document: Document, original: string): string => {
  if (/<html\b/i.test(original)) {
    const doctype = /<!doctype[^>]*>/i.exec(original);
    return `${doctype ? doctype[0] : ''}${document.documentElement.outerHTML}`;
  }
  if (/<body\b/i.test(original)) return document.body.outerHTML;
  // A fragment: the parser will have hoisted a leading <style> into the head,
  // so the head comes back with it or the message loses its stylesheet.
  return `${document.head.innerHTML}${document.body.innerHTML}`;
};

/**
 * The one entry point. Decides the strategy and applies it.
 *
 * Every declining path returns the message untouched on a white canvas, which
 * is exactly what ships today — so a parse failure, an oversized message or a
 * missing DOM degrades to the current behaviour rather than to a broken one.
 */
export const applyEmailDarkMode = (
  html: string,
  options: { enabled: boolean; isDark: boolean },
): EmailDarkResult => {
  const off: EmailDarkResult = { html, darkCanvas: false, strategy: 'off' };
  if (!options.enabled || !options.isDark) return off;
  if (typeof DOMParser === 'undefined') return off;

  try {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const body = document.body;
    if (!body) return off;
    if (document.getElementsByTagName('*').length > MAX_ELEMENTS) return off;

    if (pageIsAlreadyDark(body)) {
      return { html, darkCanvas: true, strategy: 'preserve' };
    }

    darkenSubtree(body);
    const styles = document.getElementsByTagName('style');
    for (let index = 0; index < styles.length; index += 1) {
      const sheet = styles[index]!;
      sheet.textContent = darkenStyleSheet(sheet.textContent ?? '');
    }
    return { html: serializeDocument(document, html), darkCanvas: true, strategy: 'invert' };
  } catch {
    // A message that renders on white is a far better failure than one that
    // does not render at all.
    return off;
  }
};
