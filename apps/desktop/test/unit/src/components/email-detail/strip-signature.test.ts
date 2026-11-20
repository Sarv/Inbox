// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stripSignatureFromHtml } from '../../../../../src/components/email-detail/utils';

/**
 * `stripSignatureFromHtml` runs while the thread and the email card RENDER, for
 * every message on screen, every render. Every console line the renderer writes
 * at log/info/warn/error is forwarded to app.log in a release build, so a line
 * here is one app.log write per message per render.
 */

afterEach(() => vi.restoreAllMocks());

/** Every console call made while `run` executes, joined as app.log would get it. */
function consoleLines(run: () => void): string[] {
  const calls: unknown[][] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { calls.push(args); });
  }
  run();
  return calls.map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
}

describe('stripSignatureFromHtml', () => {
  // Breaks: signatures stop being hidden in the thread and the email card.
  it('removes every signature element and reports that it did', () => {
    const body = '<p>Hello</p><div class="gmail_signature">Ann</div><div class="signature">Ann again</div>';
    const { newContent, hasSignature } = stripSignatureFromHtml(body);
    expect(hasSignature).toBe(true);
    expect(newContent).toBe('<p>Hello</p>');
  });

  // Breaks: the strip writes a line (a count, or the matching selectors) for
  // every message on every render again, a flood of app.log writes on the
  // render path that CLAUDE.md forbids for per-item logs.
  it('logs nothing when it strips a signature', () => {
    const lines = consoleLines(() => {
      stripSignatureFromHtml('<p>Hi</p><div class="gmail_signature">A</div><div class="signature">B</div><div class="sig">C</div>');
    });
    expect(lines).toEqual([]);
  });

  // Breaks: a body with no signature is altered, or the no-op path logs.
  it('leaves a body without a signature as it is, and logs nothing', () => {
    const lines = consoleLines(() => {
      expect(stripSignatureFromHtml('<p>Just text</p>')).toEqual({ newContent: '<p>Just text</p>', hasSignature: false });
      expect(stripSignatureFromHtml('')).toEqual({ newContent: '', hasSignature: false });
    });
    expect(lines).toEqual([]);
  });

  // Breaks: a parser failure throws out of a render (blank thread), or its
  // log line carries the error's message, which can quote the mail's HTML.
  it('keeps the body when parsing fails and logs the failure by class only', () => {
    vi.spyOn(DOMParser.prototype, 'parseFromString').mockImplementation(() => {
      throw new TypeError('could not parse <p>SENTINEL mail text</p>');
    });
    let result: ReturnType<typeof stripSignatureFromHtml> | undefined;
    const lines = consoleLines(() => {
      result = stripSignatureFromHtml('<p>SENTINEL mail text</p>');
    });
    expect(result).toEqual({ newContent: '<p>SENTINEL mail text</p>', hasSignature: false });
    expect(lines.join('\n')).not.toContain('SENTINEL');
    expect(lines.some((line) => line.includes('[EmailDetail] failed to strip signatures {"name":"TypeError"}'))).toBe(true);
  });
});
