/**
 * Visible text of the compose editor's HTML — what the editor's own `getText()`
 * reports once the user types. Needed wherever the body is set WITHOUT typing
 * (a restored draft, an undone send, an AI rewrite): `plainBody` gates the Send
 * button, so leaving it empty there disables Send on a message that has a body.
 *
 * DOMParser rather than `div.innerHTML`: a parsed document is inert, so an
 * `<img onerror>` in pasted or AI-returned HTML neither loads nor runs.
 */
export function editorHtmlToText(html: string | null | undefined): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.textContent ?? '';
}
