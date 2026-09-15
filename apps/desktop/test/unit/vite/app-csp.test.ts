import { describe, expect, it } from 'vitest';

import { ATTACHMENT_SCHEME } from '../../../../../packages/core/src/utils/attachment-kind';
import { APP_CSP_DIRECTIVES, APP_IMG_SRC, buildAppCsp, injectCspMeta } from '../../../vite/app-csp';

// Regression, confirmed by experiment in Electron 43: an `<iframe srcdoc>`
// INHERITS the parent document's CSP and its own <meta> policy can only narrow
// that. The email body is exactly such a frame, so while this document said
// `img-src 'self' data: blob:` NO remote image in ANY email could load in a
// packaged build — and "Load images" was a button that did nothing, with no
// error anywhere. It reproduced only in production, because the policy is not
// injected in dev at all. These pin both halves of that.

const directive = (name: string): string =>
  APP_CSP_DIRECTIVES.find((d) => d.startsWith(`${name} `))!;

describe('the app document policy', () => {
  // Breaks: every remote email image goes dark in the packaged app, and nothing
  // the user can click brings it back.
  it('allows remote image sources, which the email iframe narrows for itself', () => {
    expect(APP_IMG_SRC).toContain('https:');
    expect(APP_IMG_SRC).toContain('http:');
    expect(directive('img-src')).toBe(`img-src ${APP_IMG_SRC}`);
    // …and still allows what the app's own chrome and the blocked-images mode use.
    expect(APP_IMG_SRC).toContain("'self'");
    expect(APP_IMG_SRC).toContain('data:');
    expect(APP_IMG_SRC).toContain('blob:');
  });

  // Breaks: widening img-src quietly widens the rest of the policy with it.
  // Remote IMAGES are the concession; remote script/frames/objects are not.
  it('widens nothing but images', () => {
    expect(directive('script-src')).toBe("script-src 'self'");
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(APP_CSP_DIRECTIVES).toContain("object-src 'none'");
    expect(APP_CSP_DIRECTIVES).toContain("base-uri 'self'");
    expect(APP_CSP_DIRECTIVES).toContain("form-action 'none'");
    // No remote scheme reaches a frame, a connection or a media element.
    for (const name of ['frame-src', 'connect-src', 'media-src']) {
      expect(directive(name)).not.toContain('http:');
    }
  });

  // Breaks: the in-app attachment viewer renders blank in the PACKAGED app only
  // — a PDF frame, an <img>, an <audio>/<video> and the fetch() a text
  // attachment is read with are four separate directives, and CSP has no
  // wildcard for a custom scheme, so missing one silently kills that kind. Dev
  // injects no policy at all, so none of it can reproduce there.
  it('allows the attachment scheme everywhere the viewer loads from', () => {
    for (const name of ['img-src', 'frame-src', 'media-src', 'connect-src']) {
      expect(directive(name)).toContain(`${ATTACHMENT_SCHEME}:`);
    }
  });

  // Breaks: a policy that is syntactically wrong is IGNORED WHOLE by Chromium,
  // so the app ships with no CSP at all and nothing looks different.
  it('serialises as one semicolon-separated header value', () => {
    const csp = buildAppCsp();
    expect(csp.split('; ')).toEqual([...APP_CSP_DIRECTIVES]);
    expect(csp).not.toContain(';;');
    expect(csp.endsWith(';')).toBe(false);
  });
});

describe('injectCspMeta', () => {
  const run = (mode: string) => {
    const plugin = injectCspMeta(mode) as any;
    return plugin.transformIndexHtml.handler('<html><head></head></html>');
  };

  // Breaks: the packaged renderer loads from file:// with no policy at all —
  // no header CSP is possible there, so this <meta> is the only mechanism.
  it('injects the meta tag into a production build', () => {
    const result = run('production');
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0]).toMatchObject({
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: buildAppCsp() },
      injectTo: 'head-prepend',
    });
  });

  // Breaks: dev dies on first paint. Vite HMR and React Refresh need
  // 'unsafe-eval'/'unsafe-inline' and a ws: connection, none of which this
  // policy grants — so dev must get no policy, not a relaxed one.
  it('injects nothing in dev, returning the html untouched', () => {
    const html = '<html><head></head></html>';
    expect(run('development')).toBe(html);
    expect(run('test')).toBe(html);
  });
});
