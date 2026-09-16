// @vitest-environment happy-dom
// The adapter imported below pulls in the library's transform, which needs a
// DOMParser at module load. The second block here drives the real DOM: it loads
// the library's stylesheet next to this one and reads back what a bubble
// actually computes to, which is the only way to prove a cascade.
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';

import { describe, expect, it } from 'vitest';

import { AS_SENT_MARKER } from '../../../../src/components/email-detail/chat-message-adapter';

/**
 * The app's bridge stylesheet for `@sarv-in/email-chat-view`.
 *
 * What breaks if this file goes red: a mail rendered as sent gets the library's
 * per-sender pastel painted over it again — the green wash across a white
 * notification. Nothing else can catch that. The rule and the marker live in
 * two different languages, so a rename on either side is silent, and the
 * `!important` is load-bearing rather than lazy: the tint is an INLINE style on
 * the bubble element and an inline declaration can only be beaten by an
 * important one.
 */
const THEME = readFileSync(join(__dirname, '../../../../src/styles/chat-view-theme.css'), 'utf8');

/** The as-sent rule, from its selector to its closing brace. */
const RULE_START = THEME.indexOf('.sec-bubble[data-sec-applied');
const AS_SENT_RULE = THEME.slice(RULE_START, THEME.indexOf('}', RULE_START) + 1);

describe('chat-view-theme.css', () => {
  // Regression: the selector matches on the value the adapter puts in
  // `applied`, which the library forwards verbatim as `data-sec-applied`.
  it('keys the as-sent rule on the marker the adapter emits', () => {
    expect(THEME).toContain(`[data-sec-applied~='${AS_SENT_MARKER}']`);
  });

  // Regression: drop `!important` and the rule still parses, still looks right
  // in review, and does nothing at all — the library's inline style wins.
  it('marks every as-sent declaration important', () => {
    const declarations = AS_SENT_RULE.split('{')[1]!
      .replace('}', '')
      .split(';')
      .map((each) => each.trim())
      .filter(Boolean);

    expect(declarations.length).toBeGreaterThan(0);
    for (const declaration of declarations) {
      expect(declaration).toContain('!important');
    }
  });

  // Regression: the framed body's background AND the wash behind it are both
  // derived from `--sec-doc-page`, so neutralising only the bubble leaves the
  // tint showing through the email itself.
  it('neutralises the page token the framed body sits on', () => {
    expect(AS_SENT_RULE).toContain('--sec-doc-page');
  });

  // A literal colour here is a bug: the rule has to follow the theme switch,
  // and the app's dark mode redeclares the token, not this file.
  it('takes its colours from design-system tokens', () => {
    expect(AS_SENT_RULE).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(AS_SENT_RULE).toContain('var(--card)');
  });
});

/** The library's own stylesheet, resolved through the package rather than a
 *  guessed path — pnpm hoists it outside `apps/desktop/node_modules`. */
const LIBRARY = readFileSync(
  join(dirname(createRequire(import.meta.url).resolve('@sarv-in/email-chat-view')), 'style.css'),
  'utf8',
);

/** The shadcn triplets the bridge wraps in `hsl()`. Values are arbitrary; every
 *  assertion below compares one bubble against another, never against a colour. */
const APP_TOKENS = `:root{
  --primary: 221 83% 53%; --border: 214 32% 91%; --card: 0 0% 100%;
  --accent: 210 40% 96%; --foreground: 222 47% 11%; --muted: 210 40% 96%;
  --muted-foreground: 215 16% 47%; --destructive: 0 84% 60%;
}`;

/** One bubble of each kind, in the class names the library emits. */
function bubbles() {
  document.head.innerHTML = `<style>${APP_TOKENS}</style><style>${LIBRARY}</style><style>${THEME}</style>`;
  document.body.innerHTML = [
    '<div id="plain-mine" class="sec-bubble sec-bubble--mine"></div>',
    '<div id="plain-theirs" class="sec-bubble sec-bubble--theirs"></div>',
    '<div id="doc-mine" class="sec-bubble sec-bubble--mine sec-bubble--doc"></div>',
    '<div id="doc-theirs" class="sec-bubble sec-bubble--theirs sec-bubble--doc"></div>',
    `<div id="as-sent" class="sec-bubble sec-bubble--theirs sec-bubble--doc" data-sec-applied="${AS_SENT_MARKER}"></div>`,
  ].join('');
  const of = (id: string) => getComputedStyle(document.getElementById(id)!);
  return {
    plainMine: of('plain-mine'),
    plainTheirs: of('plain-theirs'),
    docMine: of('doc-mine'),
    docTheirs: of('doc-theirs'),
    asSent: of('as-sent'),
  };
}

/**
 * What an ordinary mail's bubble computes to, with both stylesheets loaded.
 *
 * The library calls a body a document the moment it contains an `img` or a
 * `table`, so a typed mail carrying a signature card gets the document chrome:
 * a 3px brand rule down the side and a brand-soft fill. These assertions are
 * relational on purpose — they compare a document bubble against the plain
 * bubble beside it, so they keep holding when the palette changes.
 */
describe('an ordinary bubble in the cascade', () => {
  // Regression: the blue rule down the side of a mail that is just text and a
  // sign-off logo. It reads as a status the app never meant to report. The
  // as-sent bubble is the control — same classes, excluded by the `:not()` — so
  // a 1px/3px split here is proof the app's rule really won the cascade rather
  // than the library having changed its mind.
  it('draws the ordinary 1px rule on your own mail, not the document 3px', () => {
    const { docMine, asSent } = bubbles();
    expect(docMine.borderInlineStartWidth).toBe('1px');
    expect(asSent.borderInlineStartWidth).toBe('3px');
  });

  // Regression: the same rule, incoming. A per-sender pastel edge three times
  // its usual weight still says "document" about an ordinary reply.
  it('draws the ordinary 1px rule on an incoming mail', () => {
    const { docTheirs } = bubbles();
    expect(docTheirs.borderInlineStartWidth).toBe('1px');
  });

  // Regression: the brand-soft fill. Your own mail must sit on the same tint
  // whether or not it happens to carry an image.
  it('sits on the same fill as a plain bubble on your own mail', () => {
    const { plainMine, docMine } = bubbles();
    expect(docMine.backgroundColor).toBe(plainMine.backgroundColor);
    expect(docMine.borderTopColor).toBe(plainMine.borderTopColor);
  });

  // Regression: the framed body paints its own page from `--sec-doc-page`. Left
  // at the library's brand-soft it reappears as a panel inside the bubble.
  it('lets the framed body sit straight on the bubble', () => {
    bubbles();
    const page = getComputedStyle(document.getElementById('doc-mine')!).getPropertyValue(
      '--sec-doc-page',
    );
    expect(page.trim()).toBe('transparent');
  });

  // Regression: the `:not()` guard. Drop it and the rules above also strip the
  // document treatment from a mail being shown exactly as it was sent, which is
  // the one bubble that has earned it.
  it('leaves a mail shown as sent on its own page', () => {
    const { asSent, plainTheirs, docTheirs } = bubbles();
    expect(asSent.backgroundColor).toBe(plainTheirs.backgroundColor);
    expect(asSent.borderInlineStartWidth).not.toBe(docTheirs.borderInlineStartWidth);
  });
});
