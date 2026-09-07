// @vitest-environment happy-dom
// normalizeSignatureHtml deliberately uses the browser's real CSS parser
// (DOMParser) rather than regex, so this file needs a DOM. Everything else here
// is pure + localStorage-backed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { AppSettings } from '../../../../src/components/settings/types';

import { getSignatureHtml, loadSignatureState, migrateSignatures, normalizeSignatureHtml } from '../../../../src/utils/signatures';

const SETTINGS_KEY = 'sarvinbox-settings';

const writeSettings = (settings: Partial<AppSettings> | string) => {
  localStorage.setItem(SETTINGS_KEY, typeof settings === 'string' ? settings : JSON.stringify(settings));
};

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('migrateSignatures', () => {
  // Users upgrading from the single-signature build must keep their signature —
  // dropping it means every mail they send suddenly has no sign-off.
  it('promotes the legacy single `signature` string into a named signature', () => {
    const out = migrateSignatures({ signature: '<p>Thanks, Advik</p>' });
    expect(out.signatures).toEqual([{ id: 'sig-legacy', name: 'My signature', html: '<p>Thanks, Advik</p>' }]);
    expect(out.defaultSignatureNew).toBe('sig-legacy');
    expect(out.defaultSignatureReply).toBe('sig-legacy');
  });

  it('is a no-op once `signatures` is populated (idempotent)', () => {
    const existing = [{ id: 'a', name: 'A', html: '<p>A</p>' }];
    const out = migrateSignatures({ signatures: existing, signature: '<p>legacy</p>' });
    expect(out.signatures).toBe(existing);
    expect(out.defaultSignatureNew).toBe('');
  });

  it('does not invent a signature from a blank/whitespace legacy value', () => {
    expect(migrateSignatures({ signature: '   ' }).signatures).toEqual([]);
    expect(migrateSignatures({}).signatures).toEqual([]);
  });

  it('keeps already-chosen defaults instead of overwriting them with the legacy id', () => {
    const out = migrateSignatures({ signature: '<p>x</p>', defaultSignatureNew: 'chosen', defaultSignatureReply: 'chosen2' });
    expect(out.defaultSignatureNew).toBe('chosen');
    expect(out.defaultSignatureReply).toBe('chosen2');
  });

  it('tolerates a non-array `signatures` from a corrupted settings blob', () => {
    const out = migrateSignatures({ signatures: 'nope' as unknown as AppSettings['signatures'] });
    expect(out.signatures).toEqual([]);
  });
});

describe('loadSignatureState', () => {
  it('returns the disabled defaults when nothing is stored', () => {
    expect(loadSignatureState()).toEqual({
      enabled: false,
      signatures: [],
      defaultNew: '',
      defaultReply: '',
      accountSignatures: {},
    });
  });

  it('reads the enabled flag and applies the legacy migration on read', () => {
    writeSettings({ signatureEnabled: true, signature: '<p>Legacy</p>' });
    const state = loadSignatureState();
    expect(state.enabled).toBe(true);
    expect(state.signatures[0].id).toBe('sig-legacy');
  });

  it('returns the safe defaults (never throws) on a corrupted settings blob', () => {
    writeSettings('{not json');
    expect(loadSignatureState().enabled).toBe(false);
  });

  it('ignores a non-object accountSignatures value', () => {
    writeSettings({ accountSignatures: 'oops' as unknown as AppSettings['accountSignatures'] });
    expect(loadSignatureState().accountSignatures).toEqual({});
  });
});

describe('getSignatureHtml', () => {
  const sigs = [
    { id: 'work', name: 'Work', html: '<p>Advik — Work</p>' },
    { id: 'personal', name: 'Personal', html: '<p>Advik</p>' },
  ];

  it('returns nothing while signatures are switched off', () => {
    writeSettings({ signatureEnabled: false, signatures: sigs, defaultSignatureNew: 'work' });
    expect(getSignatureHtml('new')).toBe('');
  });

  it('returns nothing when no signatures exist', () => {
    writeSettings({ signatureEnabled: true, signatures: [] });
    expect(getSignatureHtml('new')).toBe('');
  });

  it('picks the context-specific global default (new vs reply)', () => {
    writeSettings({ signatureEnabled: true, signatures: sigs, defaultSignatureNew: 'work', defaultSignatureReply: 'personal' });
    expect(getSignatureHtml('new')).toBe('<p>Advik — Work</p>');
    expect(getSignatureHtml('reply')).toBe('<p>Advik</p>');
  });

  it('lets a per-account override beat the global default', () => {
    // Replying from the Gmail account must use Gmail's signature, not the global one.
    writeSettings({
      signatureEnabled: true,
      signatures: sigs,
      defaultSignatureNew: 'work',
      defaultSignatureReply: 'work',
      accountSignatures: { 'acct-gmail': { reply: 'personal' } },
    });
    expect(getSignatureHtml('reply', 'acct-gmail')).toBe('<p>Advik</p>');
    expect(getSignatureHtml('new', 'acct-gmail')).toBe('<p>Advik — Work</p>'); // no `new` override ⇒ global
    expect(getSignatureHtml('reply', 'acct-other')).toBe('<p>Advik — Work</p>'); // unknown account ⇒ global
  });

  it('falls back to the FIRST signature when no default id is set at all', () => {
    writeSettings({ signatureEnabled: true, signatures: sigs });
    expect(getSignatureHtml('new')).toBe('<p>Advik — Work</p>');
  });

  it('returns nothing when the configured default id no longer exists', () => {
    // A deleted signature must not silently fall back to an arbitrary other
    // signature — that would sign mail with the wrong identity.
    writeSettings({ signatureEnabled: true, signatures: sigs, defaultSignatureNew: 'deleted-id' });
    expect(getSignatureHtml('new')).toBe('');
  });
});

describe('normalizeSignatureHtml', () => {
  // Pasted corporate signatures often set border width+color WITHOUT a style.
  // Per CSS that renders NOTHING, so the divider bar visible in the paste editor
  // vanishes in the compose preview, the sent mail, and the recipient's client.
  it('adds the missing per-side border-style', () => {
    const out = normalizeSignatureHtml(
      '<div style="border-right-width: 2px; border-right-color: rgb(48,105,176)">x</div>',
    );
    expect(out).toContain('border-right-style: solid');
  });

  it('completes each of the four sides independently', () => {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const out = normalizeSignatureHtml(`<div style="border-${side}-width: 1px">x</div>`);
      expect(out).toContain(`border-${side}-style: solid`);
    }
  });

  it('completes a width-only or color-only declaration', () => {
    expect(normalizeSignatureHtml('<div style="border-left-color: red">x</div>')).toContain('border-left-style: solid');
  });

  it('completes the all-sides shorthand form too', () => {
    const out = normalizeSignatureHtml('<div style="border-width: 2px; border-color: #306" >x</div>');
    expect(out).toContain('border-style: solid');
  });

  it('leaves a declaration that already has a style untouched', () => {
    const html = '<div style="border-right: 2px solid #306">x</div>';
    expect(normalizeSignatureHtml(html)).toBe(html); // unchanged ⇒ original string returned verbatim
    const explicit = '<div style="border-right-width:2px;border-right-style:dashed">x</div>';
    expect(normalizeSignatureHtml(explicit)).toBe(explicit);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const once = normalizeSignatureHtml('<div style="border-top-width: 3px">x</div>');
    expect(normalizeSignatureHtml(once)).toBe(once);
  });

  it('leaves signatures with no styled elements exactly as they were', () => {
    const html = '<p>Thanks,<br>Advik</p>';
    expect(normalizeSignatureHtml(html)).toBe(html);
  });

  it('returns falsy input unchanged rather than throwing', () => {
    expect(normalizeSignatureHtml('')).toBe('');
    expect(normalizeSignatureHtml(undefined as unknown as string)).toBeUndefined();
  });

  it('preserves the rest of the signature markup (tables, images, links)', () => {
    const html = '<table><tr><td style="border-left-width:2px"><img src="cid:logo"><a href="https://sarv.com">sarv.com</a></td></tr></table>';
    const out = normalizeSignatureHtml(html);
    expect(out).toContain('cid:logo');
    expect(out).toContain('href="https://sarv.com"');
    expect(out).toContain('border-left-style: solid');
  });
});
