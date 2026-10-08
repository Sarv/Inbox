/**
 * Escape text for safe interpolation into HTML — element content AND quoted
 * attribute values. The five characters that can end a text run or an
 * attribute (& < > " ') become entities; nothing else changes.
 *
 * The one implementation: main-process HTML pages (OAuth callback, pipeline
 * notices) and the renderer's print document all used to carry their own copy.
 * Hand-written rather than a dependency because it is the complete, standard
 * five-character mapping (the same table escape-html uses) and both processes
 * need it; it is pinned by html-escape.test.ts.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (c) => ENTITIES[c]!);
}
