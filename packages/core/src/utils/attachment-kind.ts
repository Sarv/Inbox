/**
 * Attachment classification shared by the Electron main process (which decides
 * what `Content-Type` to serve over the `sarv-attachment://` scheme) and the
 * renderer (which decides which element to render it with). One module so the
 * two can never disagree about what a file is — a disagreement here is a
 * security bug, not a cosmetic one.
 *
 * Deliberately DEPENDENCY-FREE — not even `./safe-path`, and not `mime-types`.
 * The renderer deep-imports this file (see `vite/renderer-aliases.ts`), and both
 * of those pull in Node's `path`, which Vite externalizes for the browser: the
 * import resolves, then throws at runtime. Keeping the module pure is what lets
 * one copy serve both processes instead of the two drifting apart.
 */

/**
 * Attachment types we hand to the OS default app (Preview/Quick Look for images
 * & PDFs, TextEdit/Notepad for text, Word/Excel/etc. for documents,
 * QuickTime/Media Player for A/V). Opening still requires an explicit user
 * click.
 *
 * This is an ALLOW-LIST on purpose: executables and scripts are intentionally
 * EXCLUDED (.exe/.msi/.bat/.cmd/.com/.scr/.ps1/.sh/.app/.dmg/.pkg/.jar/.js/.vbs
 * …) — they fall through to "download", so a malicious attachment can never be
 * launched by a single click. `.html`/`.htm` are also excluded (would open a
 * browser — a phishing vector); they download instead.
 *
 * Moved here from the desktop renderer so the main process shares the one list.
 */
const PREVIEWABLE_EXTENSIONS = new Set([
  // documents
  'pdf',
  'txt',
  'text',
  'log',
  'md',
  'markdown',
  'csv',
  'tsv',
  'rtf',
  'json',
  'xml',
  'ics',
  'vcf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'pages',
  'numbers',
  'key',
  'epub',
  // images
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'svg',
  'heic',
  'heif',
  'ico',
  'avif',
  // audio / video
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'mp3',
  'm4a',
  'aac',
  'wav',
  'ogg',
  'flac',
]);

/** How the in-app viewer should render an attachment. */
export type AttachmentViewerKind = 'pdf' | 'image' | 'text' | 'audio' | 'video' | 'unsupported';

/**
 * Extensions the IN-APP viewer can render, grouped by the element that renders
 * them. This is deliberately NARROWER than `PREVIEWABLE_EXTENSIONS`: that list
 * answers "may the OS open this?", this one answers "can Chromium draw this?".
 *
 * Notable exclusions, all of which fall to the "open in system app" card rather
 * than rendering a broken box:
 *   • tif/tiff/heic/heif — Chromium has no decoder for these.
 *   • rtf — no renderer; the OS has one.
 *   • mkv/avi — containers Chromium won't demux.
 *   • doc/docx/xls/xlsx/ppt/pptx/odt/… — would need mammoth/SheetJS; out of scope.
 *   • html/htm — excluded above and here. Rendering sender-supplied HTML in our
 *     own renderer is a phishing/scripting vector; the email body has a
 *     sandboxed iframe with a strict CSP for that job, an attachment does not.
 */
const VIEWER_KINDS: ReadonlyArray<readonly [AttachmentViewerKind, ReadonlySet<string>]> = [
  ['pdf', new Set(['pdf'])],
  // SVG is an image HERE ONLY because the viewer renders images with <img>,
  // which never executes script in an embedded SVG. If an SVG ever reaches an
  // <iframe>/<object>/<embed> instead, its scripts run with that frame's
  // privileges — so this classification and the <img> element are one decision.
  ['image', new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])],
  [
    'text',
    new Set(['txt', 'text', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'ics', 'vcf']),
  ],
  ['audio', new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac'])],
  ['video', new Set(['mp4', 'm4v', 'mov', 'webm'])],
];

/**
 * Largest text attachment we pull into the renderer to display inline. Text is
 * fetched whole (unlike PDF/media, which stream), so an unbounded read would
 * put the entire file in a JS string on the main thread.
 */
export const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Lowercased extension of an untrusted filename, with no leading dot.
 *
 * Takes the last path segment first (both separators, because an attachment
 * filename arrives from MIME headers written on any OS), so a crafted
 * "evil.png/../payload" yields "payload"'s extension — not ".png". Every
 * extension in the allow-lists below is plain alphanumeric, so anything
 * containing a separator, a space or punctuation simply fails the set lookup and
 * lands in `unsupported`; there is no name that classifies as one type while
 * naming another.
 */
export function attachmentExtension(filename: string): string {
  const name = typeof filename === 'string' ? filename : '';
  const lastSeparator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const base = lastSeparator >= 0 ? name.slice(lastSeparator + 1) : name;
  const dot = base.lastIndexOf('.');
  // No dot, or a leading-dot name like ".gitignore" (dot at 0) — no extension.
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** True when the OS default app may open this attachment on a single click. */
export function isPreviewableAttachment(filename: string): boolean {
  return PREVIEWABLE_EXTENSIONS.has(attachmentExtension(filename));
}

/** Which element the in-app viewer should use, or `unsupported` for the fallback card. */
export function attachmentViewerKind(filename: string): AttachmentViewerKind {
  const ext = attachmentExtension(filename);
  if (!ext) return 'unsupported';
  for (const [kind, extensions] of VIEWER_KINDS) {
    if (extensions.has(ext)) return kind;
  }
  return 'unsupported';
}

/**
 * True when this attachment may be delivered to the renderer at all.
 *
 * SECURITY — this is the gate, not a hint. The `sarv-attachment://` handler
 * serves a file ONLY when this returns true, so the scheme can never hand the
 * renderer an executable, a script, an installer, or HTML. Anything else
 * reaches the user exclusively through an explicit "Save a copy" (writes to a
 * location they chose, opens nothing) or "Open in system app" (which is itself
 * gated by `isPreviewableAttachment`, the narrower launch allow-list).
 */
export function isInlineRenderableAttachment(filename: string): boolean {
  return attachmentViewerKind(filename) !== 'unsupported';
}

/**
 * The `Content-Type` for each extension the viewer renders.
 *
 * Written out rather than looked up in the `mime-types` database on purpose.
 * The set is closed and tiny — it is exactly the allow-list above — so an
 * explicit table is auditable in one screen, cannot answer for an extension we
 * never meant to serve, and keeps this module dependency-free (`mime-types`
 * needs Node's `path`, which the renderer cannot have).
 *
 * Every text kind is served as `text/plain`, including `.xml`, `.svg`-adjacent
 * markup formats, `.ics` and `.vcf`. The viewer fetches those and renders them
 * escaped in a <pre>, so a more specific type buys nothing — and `text/xml`
 * would invite Chromium to parse the document instead of showing it.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',

  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  // Safe ONLY because the viewer renders images with <img>, which never runs
  // script in an embedded SVG. See the note on VIEWER_KINDS.
  svg: 'image/svg+xml',

  txt: 'text/plain; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  tsv: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
  xml: 'text/plain; charset=utf-8',
  ics: 'text/plain; charset=utf-8',
  vcf: 'text/plain; charset=utf-8',

  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',

  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

/**
 * The `Content-Type` to serve an attachment with.
 *
 * SECURITY, two rules, both load-bearing:
 *
 *  1. The type is derived from the extension ONLY — the sender's declared MIME
 *     type is never consulted. A message can declare `report.pdf` as
 *     `text/html`; honoring that would render attacker HTML in our renderer.
 *
 *  2. A real type is returned ONLY for extensions the viewer actually renders.
 *     Everything else is `application/octet-stream`, which no browser will
 *     execute or draw. A general MIME database would happily answer `text/html`
 *     for a hostile `invoice.html` — so the allow-list, not a database, has the
 *     last word here.
 *
 * Served alongside `X-Content-Type-Options: nosniff`, so the browser cannot
 * second-guess the octet-stream either.
 */
export function attachmentContentType(filename: string): string {
  if (!isInlineRenderableAttachment(filename)) return 'application/octet-stream';
  return CONTENT_TYPES[attachmentExtension(filename)] ?? 'application/octet-stream';
}

/**
 * Read the `emails.attachment_names` column into a list of filenames.
 *
 * The column is a JSON array on rows written by the current importer, but older
 * rows hold a bare comma-separated string — both shapes are still in live
 * databases, so both must parse. Shared with the renderer's `parseAttachments`
 * so the main process's authorization check sees exactly the same names the UI
 * offered the user: if the two ever disagreed, a legitimate attachment would be
 * refused (or, worse, one the UI never showed would be served).
 */
export function parseAttachmentNames(attachmentNames?: string | null): string[] {
  if (!attachmentNames) return [];
  if (attachmentNames.startsWith('[')) {
    try {
      const parsed = JSON.parse(attachmentNames);
      // An EMPTY array is an answer ("no attachments"), not a parse failure. The
      // version this was lifted from fell through to the comma-split here, which
      // turned the literal row "[]" into an attachment named "[]".
      // Only strings: the caller matches a requested filename against this list,
      // and stringifying a stray null into the name "null" would put a phantom
      // attachment on the message.
      if (Array.isArray(parsed)) {
        return parsed.filter((name): name is string => typeof name === 'string' && name !== '');
      }
    } catch {
      // Not JSON after all — fall through to the legacy comma-separated form.
    }
  }
  return attachmentNames
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/** Scheme backing the in-app viewer. Registered as a privileged scheme in main. */
export const ATTACHMENT_SCHEME = 'sarv-attachment';

/** Fixed host of every attachment URL; the identifying parts live in the path. */
const ATTACHMENT_HOST = 'attachment';

export interface AttachmentRef {
  emailId: string;
  filename: string;
  /** Owning account, for the unified "All Inboxes" view. Optional = active account. */
  accountId?: string;
}

/**
 * Build the URL the viewer loads. Ids go in the PATH rather than the host
 * because URL parsing lowercases a host and our ids are case-sensitive.
 */
export function buildAttachmentUrl({ emailId, filename, accountId }: AttachmentRef): string {
  const path = `${encodeURIComponent(emailId)}/${encodeURIComponent(filename)}`;
  const query = accountId ? `?account=${encodeURIComponent(accountId)}` : '';
  return `${ATTACHMENT_SCHEME}://${ATTACHMENT_HOST}/${path}${query}`;
}

/**
 * Inverse of `buildAttachmentUrl`. Returns null for anything that isn't a
 * well-formed attachment URL so the protocol handler can answer 400 rather than
 * throwing. Does NOT authorize the request — the handler must still check the
 * filename against the email's declared attachments.
 */
export function parseAttachmentUrl(url: string): AttachmentRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${ATTACHMENT_SCHEME}:` || parsed.host !== ATTACHMENT_HOST) return null;

  const segments = parsed.pathname.split('/').slice(1);
  if (segments.length !== 2) return null;

  let emailId: string;
  let filename: string;
  try {
    [emailId, filename] = segments.map(decodeURIComponent);
  } catch {
    return null; // Malformed percent-encoding.
  }
  if (!emailId || !filename) return null;

  const accountId = parsed.searchParams.get('account') || undefined;
  return { emailId, filename, accountId };
}
