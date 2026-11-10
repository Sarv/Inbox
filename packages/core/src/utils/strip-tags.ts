// Cheap tag stripping for text that is scored or matched, never rendered.

/**
 * `s` with every `<…>` tag and every stray `<` removed, in one linear pass.
 *
 * For the places that only need the WORDS of a body that may be HTML — scoring,
 * name matching, a style sample for the AI — and can't afford a full HTML
 * conversion per message. Use `htmlToPlainText` when a person will read the
 * result.
 *
 * A split rather than `replace(/<[^>]+>/g, '')`: that regex scans to the end of
 * the text once per `<`, so a body of unclosed `<` (80 KB took 3 s) froze the
 * main process (CodeQL js/polynomial-redos). It also left a trailing `<script`
 * in place (js/incomplete-multi-character-sanitization); here no `<` survives,
 * so the output can never contain a tag, whatever it is later used for.
 *
 * A well-formed tag goes exactly as it did under the regex. Where the two
 * differ is malformed markup: a `<` with no `>` before the next `<` (or the
 * end) is dropped on its own and the text after it is kept, and an empty `<>`
 * is dropped too.
 */
export function stripTags(s: string): string {
  const parts = s.split('<');
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const gt = parts[i].indexOf('>');
    out += gt < 0 ? parts[i] : parts[i].slice(gt + 1);
  }
  return out;
}
