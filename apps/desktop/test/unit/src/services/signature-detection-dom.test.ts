// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectSignature, extractSignatureBySelector } from '../../../../src/services/ai-service';

/**
 * Signature detection parses a mail body (a stranger's HTML, or whatever the
 * user pastes into Settings → AI → Signature to test it) to find the signature
 * element. CodeQL reads that parse as "DOM text reinterpreted as HTML"
 * (js/xss-through-dom). It is not: the HTML is parsed with DOMParser into a
 * separate, inert document — no browsing context, so its scripts never run and
 * nothing it names is fetched — and what comes back out is a selector, the
 * element's markup as a STRING (rendered as text in a <pre>), and its text.
 *
 * What breaks if this file fails: the parse moved into the live window (an
 * `innerHTML` on an attached node, `insertAdjacentHTML`, …), where mail HTML
 * lands in the renderer's own document and its handlers can run there.
 */

const HOSTILE = [
  '<p>Hello</p>',
  '<img src="x:" onerror="window.__pwned = \'img\'">',
  '<script>window.__pwned = \'script\'</script>',
  '<div class="gmail_signature" data-smartmail="gmail_signature">Jane Doe',
  '<img src="y:" onerror="window.__pwned = \'signature\'"><svg onload="window.__pwned = \'svg\'"></svg>',
  '</div>',
].join('');

const pwned = () => (window as unknown as { __pwned?: string }).__pwned;
const signatures = { getByEmail: vi.fn(), save: vi.fn() };

let liveDocument: string;
beforeEach(() => {
  delete (window as unknown as { __pwned?: string }).__pwned;
  document.body.innerHTML = '<main id="app">inbox</main>';
  liveDocument = document.documentElement.outerHTML;
  localStorage.setItem('sarvinbox-ai-features', JSON.stringify([{ id: 'signature-detection', enabled: true }]));
  signatures.getByEmail.mockReset().mockResolvedValue({ success: true, data: null });
  signatures.save.mockReset().mockResolvedValue({ success: true });
  (window as unknown as { electronAPI: unknown }).electronAPI = { signatures };
});
afterEach(() => {
  localStorage.clear();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('signature detection on hostile mail HTML', () => {
  // Breaks: see the file header — mail HTML parsed into the live document.
  it('extracts the signature markup as a string without touching the live document', () => {
    const html = extractSignatureBySelector(HOSTILE, 'div.gmail_signature');

    expect(typeof html).toBe('string');
    expect(html).toContain('onerror');
    expect(document.documentElement.outerHTML).toBe(liveDocument);
    expect(document.querySelector('img, script, svg, .gmail_signature')).toBeNull();
    expect(pwned()).toBeUndefined();
  });

  // Breaks: the common-selector path (no AI, no cache) parses into the live
  // document, or hands back the element instead of text.
  it('detects by a common selector and returns markup and text, never live nodes', async () => {
    const result = await detectSignature(HOSTILE, 'jane@example.test', 'email-1');

    expect(result).toMatchObject({ hasSignature: true, htmlSelector: expect.stringContaining('gmail_signature'), signatureText: 'Jane Doe' });
    expect(typeof result.sampleHtml).toBe('string');
    expect(signatures.save).toHaveBeenCalledWith(expect.objectContaining({ sampleHtml: result.sampleHtml }));
    expect(document.documentElement.outerHTML).toBe(liveDocument);
    expect(pwned()).toBeUndefined();
  });

  // Breaks: the cached-selector path (which parses twice: to find the element,
  // then to read its text) parses into the live document.
  it('re-uses a cached selector the same inert way', async () => {
    signatures.getByEmail.mockResolvedValue({ success: true, data: { htmlSelector: 'div.gmail_signature', confidence: 'high' } });

    const result = await detectSignature(HOSTILE, 'jane@example.test');

    expect(result).toMatchObject({ hasSignature: true, fromCache: true, signatureText: 'Jane Doe' });
    expect(document.documentElement.outerHTML).toBe(liveDocument);
    expect(pwned()).toBeUndefined();
  });
});
