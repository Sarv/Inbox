/**
 * Where somebody else's email begins — `@sarv-in/email-spam-scan/quote` now.
 *
 * The markers and the cut were written here, for two callers that must not
 * drift apart: signature mining (which otherwise attributes the quoted
 * sender's phone number to whoever forwarded it) and bulk-mail classification
 * (which otherwise condemns a human reply for the tracking links of the
 * newsletter quoted underneath it — the longer the thread, the more certain
 * the misfire). The library had grown its own list for a third caller, the
 * spam scorer, so the two were folded into one corpus there and this module
 * became the seam. A marker list in two places is the worst kind of
 * duplication: both copies keep returning a plausible string while they drift.
 *
 * Imported from the `/quote` subpath, NOT the package root, and that is
 * load-bearing: `bulk-mail.ts` imports this module and is aliased straight
 * into the renderer bundle (see `apps/desktop/vite/renderer-aliases.ts`), so
 * whatever it imports, the browser imports. The root entry pulls in the
 * scorer's address parser and freemail corpus — the latter a CommonJS array
 * with no default export, which the Vite dev server serves unconverted and
 * which blanks the window. `/quote` is zero-dependency by contract, and the
 * library has a test that keeps it that way.
 *
 * WHAT CHANGED IN THE FOLD: the cut now also fires on an attribution that
 * opens with a name rather than "On", and it no longer fires on a bare
 * `From:` line or a five-character underscore rule — both of which appear in
 * ordinary prose and directly above the signature this strip exists to keep.
 * `stripQuotedTail` still leaves the signature in place; the library's
 * `ownWords` is the same cut with the sign-off removed, which is what a
 * scorer wants and what a contact miner must never be given.
 */
export { QUOTE_MARKERS, stripQuotedTail } from '@sarv-in/email-spam-scan/quote';
