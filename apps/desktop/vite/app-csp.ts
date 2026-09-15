import type { Plugin } from 'vite';

// The scheme name comes from the same module the protocol handler and the
// renderer use, so the policy can never allow a scheme we stopped serving (or,
// worse, keep blocking the one we do).
import { ATTACHMENT_SCHEME } from '../../../packages/core/src/utils/attachment-kind';

/**
 * The app document's Content-Security-Policy, and the plugin that injects it.
 *
 * The packaged renderer loads from `file://`, so a response-header CSP cannot be
 * applied to it and a `<meta>` tag is the right mechanism. Injected ONLY in a
 * production build: Vite HMR and React Refresh need `'unsafe-eval'` /
 * `'unsafe-inline'` and a `ws:` connection, so a dev build gets none. This is
 * defense-in-depth on top of sandbox + contextIsolation.
 */

/**
 * Sources allowed for images in the APP document.
 *
 * `https:` / `http:` are here for the email body, not for the app — the app's
 * own chrome loads nothing remote. An email body renders in an `<iframe srcdoc>`
 * (`SandboxedEmailBody.tsx`), and a srcdoc frame INHERITS its parent document's
 * CSP: the policy the frame injects for itself can only narrow that, never widen
 * it. So with `img-src 'self' data: blob:` here, no remote image in any email
 * could load in a packaged build however the user had configured it, and the
 * "Load images" button was a no-op that produced no error anywhere — a bug that
 * could not reproduce in dev, where no CSP is injected at all.
 *
 * Privacy is still enforced, and still in the frame: with remote images blocked
 * the frame narrows itself to `img-src data: blob:`, which is what actually
 * stops tracking pixels. This directive only decides the ceiling that narrowing
 * happens under. `http:` is listed alongside `https:` because plenty of old mail
 * references plain-http images, and Gmail renders those too (proxied); a mixed-
 * content image leaks no app state — the frame is sandboxed and has no origin
 * privileges to lose.
 */
export const APP_IMG_SRC = `'self' data: blob: https: http: ${ATTACHMENT_SCHEME}:`;

/**
 * The attachment scheme has to appear in every directive the viewer loads
 * through, because CSP has no "any custom scheme" wildcard and `'self'` does not
 * cover it: `img-src` for image attachments, `frame-src` for the PDF frame,
 * `media-src` for audio/video, and `connect-src` for the `fetch()` a text
 * attachment is read with. Miss one and that kind renders blank in a PACKAGED
 * build only — dev injects no policy at all, so it cannot reproduce there.
 * `media-src` is spelled out rather than left to `default-src 'self'` for the
 * same reason.
 */
export const APP_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src ${APP_IMG_SRC}`,
  "font-src 'self' data:",
  `connect-src 'self' https: ${ATTACHMENT_SCHEME}:`,
  `frame-src 'self' data: blob: ${ATTACHMENT_SCHEME}:`,
  `media-src 'self' data: blob: ${ATTACHMENT_SCHEME}:`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
];

/** The policy as it is written into the `<meta>` tag. */
export function buildAppCsp(): string {
  return APP_CSP_DIRECTIVES.join('; ');
}

/** Inject the policy into `index.html` — production builds only. */
export function injectCspMeta(mode: string): Plugin {
  return {
    name: 'inject-csp-meta',
    transformIndexHtml: {
      order: 'post' as const,
      handler(html: string) {
        if (mode !== 'production') return html;
        return {
          html,
          tags: [
            {
              tag: 'meta',
              attrs: { 'http-equiv': 'Content-Security-Policy', content: buildAppCsp() },
              injectTo: 'head-prepend' as const,
            },
          ],
        };
      },
    },
  };
}
