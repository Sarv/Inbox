// @vitest-environment happy-dom
// First: makes happy-dom faithful enough for the real DOMPurify (see the helper).
import '../../../helpers/dompurify-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignatureEditor } from '../../../../src/components/SignatureEditor';
import { act, cleanup, fire, render } from '../../../helpers/render';

/**
 * The signature editor writes stored HTML straight into a contentEditable in
 * the MAIN app document — the one with the preload bridge. Only the release
 * build's CSP (`script-src 'self'`) stands between it and an inline handler;
 * the dev build has none, and markup or CSS gets in either way.
 *
 * What breaks if this file goes red: a signature carrying `<img onerror>` (a
 * restored settings blob, a pasted signature saved by an older build, a legacy
 * `signature` string copied in verbatim) runs script with the app's privileges
 * the moment Settings opens it, wherever the CSP is missing or weakened. Or, the other way, the fix over-reaches and a
 * designed signature loses the tables, inline styles and links it was pasted
 * for. Or opening a signature silently rewrites the saved copy.
 */

const UNSAFE =
  '<p>Regards</p>' +
  '<img src="x" onerror="window.__sigPwned = 1">' +
  '<script>window.__sigPwned = 2</script>' +
  '<a href="javascript:window.__sigPwned=3">click</a>';

const DESIGNED =
  '<table style="border-collapse: collapse;" width="400"><tbody><tr>' +
  '<td valign="top" style="border-right: 2px solid rgb(48, 105, 176); color: rgb(51, 102, 153);">' +
  '<a href="https://sarv.com" target="_blank">Sarv</a>' +
  '</td></tr></tbody></table>';

const editorOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[contenteditable]')!;

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__sigPwned;
});

describe('SignatureEditor: what reaches the live DOM', () => {
  // Regression (L-10): the stored value was assigned to innerHTML as-is, and
  // DOMPurify only ran on the way OUT — an onerror handler was live in the app
  // document before the user typed anything.
  it('strips event handlers, scripts and javascript: links before the value is shown', () => {
    const view = render(<SignatureEditor value={UNSAFE} onChange={() => {}} />);
    const html = editorOf(view.container).innerHTML;

    expect(html).toContain('Regards');
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:/i);
    expect((window as unknown as Record<string, unknown>).__sigPwned).toBeUndefined();
  });

  // Regression: sanitising on the way in must not cost a designed signature its
  // layout — tables, inline styles, sizing attributes and links are the point.
  it('keeps tables, inline styles and links', () => {
    const view = render(<SignatureEditor value={DESIGNED} onChange={() => {}} />);
    const editor = editorOf(view.container);

    const table = editor.querySelector('table')!;
    expect(table).not.toBeNull();
    expect(table.getAttribute('width')).toBe('400');
    expect(table.getAttribute('style')).toContain('border-collapse');
    const cell = editor.querySelector('td')!;
    expect(cell.getAttribute('valign')).toBe('top');
    expect(cell.getAttribute('style')).toContain('border-right');
    const link = editor.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://sarv.com');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  // Regression: opening a signature must never write it back. If mounting
  // emitted, merely viewing Settings would mark the settings dirty and could
  // overwrite the saved copy with a re-serialised one.
  it('does not call onChange on mount, even when the stored value had something to strip', () => {
    const onChange = vi.fn();
    render(<SignatureEditor value={UNSAFE} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });

  // Regression: switching to another signature without a remount resets the
  // editor — and that path is a second innerHTML sink, so it must be sanitised
  // as well, not just the first mount.
  it('sanitises an external value change too', () => {
    const onChange = vi.fn();
    const view = render(<SignatureEditor value="<p>First</p>" onChange={onChange} />);
    view.rerender(<SignatureEditor value={UNSAFE} onChange={onChange} />);

    const html = editorOf(view.container).innerHTML;
    expect(html).toContain('Regards');
    expect(html).not.toContain('First');
    expect(html).not.toMatch(/onerror/i);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('SignatureEditor: what it emits', () => {
  // Regression: whatever ends up in the editable DOM (a paste, a drop) is
  // sanitised again on the way out, so the saved signature is clean even when
  // the unsafe markup arrived after mount.
  it('emits sanitised HTML on input', () => {
    const onChange = vi.fn();
    const view = render(<SignatureEditor value="<p>Hi</p>" onChange={onChange} />);
    const editor = editorOf(view.container);

    const pasted = document.createElement('img');
    pasted.setAttribute('src', 'x');
    pasted.setAttribute('onerror', 'window.__sigPwned = 1');
    editor.appendChild(pasted);
    fire(editor, 'input');

    expect(onChange).toHaveBeenCalledTimes(1);
    const emitted = onChange.mock.calls[0][0] as string;
    expect(emitted).toContain('Hi');
    expect(emitted).toContain('<img');
    expect(emitted).not.toMatch(/onerror/i);
  });

  // Regression: the editor's own emit coming back as the new `value` must not
  // reset the DOM — a reset on every keystroke throws the caret to the start.
  it('does not reset the DOM when its own emitted value comes back as the prop', () => {
    const onChange = vi.fn();
    const view = render(<SignatureEditor value="<p>Hi</p>" onChange={onChange} />);
    const editor = editorOf(view.container);
    const paragraph = editor.querySelector('p')!;
    paragraph.appendChild(document.createTextNode(' there'));
    fire(editor, 'input');

    view.rerender(<SignatureEditor value={onChange.mock.calls[0][0]} onChange={onChange} />);

    // Same node, not a re-parsed copy: the DOM was left alone.
    expect(editor.querySelector('p')).toBe(paragraph);
  });
});

describe('SignatureEditor: inserting an image', () => {
  // A data URL whose MIME part carries a `"` — what an interpolated
  // `<img src="${src}">` turns into a second attribute.
  const HOSTILE_DATA_URL = 'data:image/png" onerror="window.__sigPwned=1;base64,AAAA';
  let execCommand: ReturnType<typeof vi.fn>;
  const original = Object.getOwnPropertyDescriptor(document, 'execCommand');

  beforeEach(() => {
    execCommand = vi.fn(() => true);
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true, writable: true });
    // The reader's result is what the component builds markup from, so it is
    // fixed here rather than depending on how the DOM shim encodes a File.
    vi.stubGlobal(
      'FileReader',
      class {
        result: string | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {
          this.result = HOSTILE_DATA_URL;
          queueMicrotask(() => this.onload?.());
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (original) Object.defineProperty(document, 'execCommand', original);
    else delete (document as unknown as Record<string, unknown>).execCommand;
  });

  // Regression (L-10): the picked file's data URL was interpolated into an
  // `<img src="…">` string handed to insertHTML. A data URL carries the file's
  // MIME type, so a `"` in it closed the attribute and added a live handler.
  it('inserts the picked image with its data URL only as an attribute value', async () => {
    const view = render(<SignatureEditor value="" onChange={() => {}} />);
    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['png'], 'logo.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });

    fire(input, 'change');
    await vi.waitFor(() => {
      expect(execCommand.mock.calls.some(([command]) => command === 'insertHTML')).toBe(true);
    });
    await act(async () => {});

    const [, , html] = execCommand.mock.calls.find(([command]) => command === 'insertHTML')!;
    const img = new DOMParser().parseFromString(html as string, 'text/html').querySelector('img')!;
    expect(img).not.toBeNull();
    expect(img.getAttributeNames().sort()).toEqual(['alt', 'src', 'style']);
    expect(img.getAttribute('src')).toBe(HOSTILE_DATA_URL);
    expect(img.getAttribute('style')).toContain('width:200px');
  });
});
