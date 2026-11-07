/**
 * Text that did not come from our own code — a renderer-forwarded log record, a
 * server's error message — made safe to write as ONE line of app.log.
 *
 * CR and LF become the visible escapes `\r` / `\n`, and every other control
 * character (ESC, NUL, the Unicode line/paragraph separators, …) becomes
 * `\uXXXX`, so the text can neither start a fake line that reads as the main
 * process's own nor drive a terminal that later `cat`s the file. Tabs stay.
 */
export function toOneLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return c;
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}
