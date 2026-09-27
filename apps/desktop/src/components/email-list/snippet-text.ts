// The body preview a list row shows, cut to the length its clamp can display —
// pure, so the budget is tested without rendering a row. Shared by ThreadCard
// (up to two lines) and CompactThreadRow (one, inline after the subject) so the
// two layouts cannot drift apart.
//
// Why cut it at all, when CSS clamps the line count anyway: `cleanBody` is the
// WHOLE message. Handing a multi-kilobyte string to a clamped element makes the
// engine lay out text that can never be seen — once per row, on every render of
// a list that can hold hundreds.

/** Roughly the characters that fill one clamped line at a usual list width. */
export const SNIPPET_CHARS_PER_LINE = 100;

/** The preview text for `lines` lines of body. Empty when nothing is shown. */
export const snippetText = (cleanBody: string | null | undefined, lines: number): string =>
  lines <= 0 ? '' : (cleanBody ?? '').substring(0, SNIPPET_CHARS_PER_LINE * lines);
