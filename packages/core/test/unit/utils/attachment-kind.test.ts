import { describe, it, expect } from 'vitest';

import {
  ATTACHMENT_SCHEME,
  attachmentContentType,
  attachmentExtension,
  attachmentViewerKind,
  buildAttachmentUrl,
  isInlineRenderableAttachment,
  isPreviewableAttachment,
  parseAttachmentNames,
  parseAttachmentUrl,
} from '../../../src/utils/attachment-kind';

// This module decides, from an attacker-chosen filename, BOTH which element the
// in-app viewer renders an attachment with AND which Content-Type the main
// process serves it as. Those two decisions must always agree and must never
// land untrusted bytes in a scripting context. Every case below is either that
// agreement or one of the exclusions that keeps it true.

describe('attachmentExtension', () => {
  it('lowercases and strips the dot', () => {
    expect(attachmentExtension('Report.PDF')).toBe('pdf');
    expect(attachmentExtension('archive.tar.GZ')).toBe('gz');
  });

  // Regression: a name with no usable extension must not fall back to some
  // earlier segment — it has to classify as unsupported, not as whatever the
  // last dot happened to precede.
  it('returns empty for names with no extension', () => {
    expect(attachmentExtension('README')).toBe('');
    expect(attachmentExtension('')).toBe('');
  });

  // Regression: ".gitignore" is a dotfile, not a file of type "gitignore".
  // Reading it as an extension would let ".html" (a leading-dot name) classify
  // off a segment that isn't really an extension.
  it('treats a leading-dot name as having no extension', () => {
    expect(attachmentExtension('.gitignore')).toBe('');
    expect(attachmentExtension('.env')).toBe('');
  });

  // Regression: the extension must come from the SAME sanitized basename we
  // write to disk. If a traversal payload could shift the extension, the
  // Content-Type we serve would describe a different file than the one we read.
  it('classifies from the sanitized basename, not the raw path', () => {
    expect(attachmentExtension('../../etc/passwd.png')).toBe('png');
    expect(attachmentExtension('evil.png/../shell.sh')).toBe('sh');
  });
});

describe('attachmentViewerKind', () => {
  it('maps each renderable family to its element', () => {
    expect(attachmentViewerKind('a.pdf')).toBe('pdf');
    expect(attachmentViewerKind('a.png')).toBe('image');
    expect(attachmentViewerKind('a.jpeg')).toBe('image');
    expect(attachmentViewerKind('a.gif')).toBe('image');
    expect(attachmentViewerKind('a.webp')).toBe('image');
    expect(attachmentViewerKind('a.bmp')).toBe('image');
    expect(attachmentViewerKind('a.ico')).toBe('image');
    expect(attachmentViewerKind('a.avif')).toBe('image');
    expect(attachmentViewerKind('a.txt')).toBe('text');
    expect(attachmentViewerKind('a.log')).toBe('text');
    expect(attachmentViewerKind('a.md')).toBe('text');
    expect(attachmentViewerKind('a.markdown')).toBe('text');
    expect(attachmentViewerKind('a.csv')).toBe('text');
    expect(attachmentViewerKind('a.tsv')).toBe('text');
    expect(attachmentViewerKind('a.json')).toBe('text');
    expect(attachmentViewerKind('a.xml')).toBe('text');
    expect(attachmentViewerKind('a.ics')).toBe('text');
    expect(attachmentViewerKind('a.vcf')).toBe('text');
    expect(attachmentViewerKind('a.mp3')).toBe('audio');
    expect(attachmentViewerKind('a.m4a')).toBe('audio');
    expect(attachmentViewerKind('a.aac')).toBe('audio');
    expect(attachmentViewerKind('a.wav')).toBe('audio');
    expect(attachmentViewerKind('a.ogg')).toBe('audio');
    expect(attachmentViewerKind('a.flac')).toBe('audio');
    expect(attachmentViewerKind('a.mp4')).toBe('video');
    expect(attachmentViewerKind('a.m4v')).toBe('video');
    expect(attachmentViewerKind('a.mov')).toBe('video');
    expect(attachmentViewerKind('a.webm')).toBe('video');
  });

  // SECURITY. SVG is classified as an image because the viewer draws images
  // with <img>, which never runs an embedded <script>. If this ever returned a
  // kind rendered by an iframe/object/embed, a hostile SVG attachment would
  // execute script inside our own renderer.
  it('classifies SVG as an image (rendered by <img>, which cannot execute its script)', () => {
    expect(attachmentViewerKind('logo.svg')).toBe('image');
    expect(attachmentViewerKind('LOGO.SVG')).toBe('image');
  });

  // SECURITY. Regression: re-opening the one-click launch vector that the
  // allow-list was written to close. HTML would be a phishing surface; the rest
  // are executables and scripts.
  it('refuses to render HTML, executables and scripts in-app', () => {
    for (const name of [
      'invoice.html', 'invoice.htm', 'setup.exe', 'setup.msi', 'run.bat', 'run.cmd',
      'run.com', 'fake.scr', 'go.ps1', 'go.sh', 'App.app', 'disk.dmg', 'pkg.pkg',
      'lib.jar', 'evil.js', 'evil.vbs',
    ]) {
      expect(attachmentViewerKind(name)).toBe('unsupported');
    }
  });

  // Regression: showing a broken image box instead of the "open in system app"
  // card. Chromium has no decoder for these, so classifying them as renderable
  // would look like the feature is failing.
  it('sends formats Chromium cannot decode to the fallback card', () => {
    for (const name of ['scan.tif', 'scan.tiff', 'photo.heic', 'photo.heif', 'notes.rtf', 'clip.mkv', 'clip.avi']) {
      expect(attachmentViewerKind(name)).toBe('unsupported');
    }
  });

  // Documented v1 limitation, not an accident: Office rendering needs
  // mammoth/SheetJS and is deliberately out of scope, so these fall back to the
  // system app rather than pretending to render.
  it('treats Office documents as unsupported in v1 (deliberate scope limit)', () => {
    for (const name of ['q3.docx', 'q3.doc', 'sheet.xlsx', 'sheet.xls', 'deck.pptx', 'deck.ppt', 'doc.odt', 'book.epub']) {
      expect(attachmentViewerKind(name)).toBe('unsupported');
    }
  });

  it('treats unknown and extensionless names as unsupported', () => {
    expect(attachmentViewerKind('data.qqq')).toBe('unsupported');
    expect(attachmentViewerKind('LICENSE')).toBe('unsupported');
  });
});

describe('isPreviewableAttachment', () => {
  // Regression: this list gates shell.openPath (what the OS may launch on one
  // click) and is WIDER than the in-app viewer's list. Narrowing it would
  // silently remove "open in system app" for Office files; widening it would
  // reopen the executable-launch vector.
  it('keeps the OS-open allow-list wider than the in-app list, but still excludes executables', () => {
    expect(isPreviewableAttachment('q3.docx')).toBe(true);
    expect(isPreviewableAttachment('scan.tiff')).toBe(true);
    expect(isPreviewableAttachment('clip.mkv')).toBe(true);
    expect(attachmentViewerKind('q3.docx')).toBe('unsupported');

    expect(isPreviewableAttachment('setup.exe')).toBe(false);
    expect(isPreviewableAttachment('invoice.html')).toBe(false);
    expect(isPreviewableAttachment('evil.js')).toBe(false);
  });

  // Regression: anything the in-app viewer renders must also be something we
  // were already willing to open, so the viewer never widens the trust boundary.
  it('covers every extension the in-app viewer will render', () => {
    for (const name of ['a.pdf', 'a.png', 'a.svg', 'a.txt', 'a.csv', 'a.json', 'a.mp3', 'a.mp4', 'a.webm']) {
      expect(isPreviewableAttachment(name)).toBe(true);
      expect(attachmentViewerKind(name)).not.toBe('unsupported');
    }
  });
});

describe('attachmentContentType', () => {
  it('derives the type from the extension', () => {
    expect(attachmentContentType('a.pdf')).toBe('application/pdf');
    expect(attachmentContentType('a.png')).toBe('image/png');
    expect(attachmentContentType('a.svg')).toBe('image/svg+xml');
    expect(attachmentContentType('a.txt')).toContain('text/plain');
  });

  // Regression: text served without a charset is decoded with the browser's
  // guess, which mangles non-ASCII in a previewed .txt/.csv.
  it('includes a charset for text so non-ASCII renders correctly', () => {
    expect(attachmentContentType('a.txt')).toContain('charset=utf-8');
    expect(attachmentContentType('a.csv')).toContain('charset=utf-8');
  });

  // SECURITY. Regression: an unknown type that the browser sniffs and decides
  // to render. octet-stream plus nosniff means it is never executed or drawn.
  it('falls back to octet-stream for unknown and extensionless names', () => {
    expect(attachmentContentType('data.qqq')).toBe('application/octet-stream');
    expect(attachmentContentType('LICENSE')).toBe('application/octet-stream');
  });

  // SECURITY. Regression caught by this test during development: the MIME
  // database happily answers `text/html` for .html and `application/x-msdos-program`
  // for .exe. Serving those would make a hostile attachment live content in our
  // own renderer. The render allow-list, not the MIME database, has the last word.
  it('forces octet-stream for every type the viewer will not render', () => {
    for (const name of [
      'invoice.html', 'invoice.htm', 'setup.exe', 'go.sh', 'evil.js', 'evil.vbs',
      'lib.jar', 'disk.dmg', 'q3.docx', 'sheet.xlsx', 'notes.rtf', 'scan.tiff',
    ]) {
      expect(attachmentContentType(name)).toBe('application/octet-stream');
    }
  });

  // SECURITY. The sender's declared MIME type is never an input here — this
  // function only takes a filename. A message declaring "report.pdf" as
  // text/html must still be served as application/pdf.
  it('always agrees with the viewer kind, since both read only the extension', () => {
    expect(attachmentContentType('report.pdf')).toBe('application/pdf');
    expect(attachmentViewerKind('report.pdf')).toBe('pdf');
    expect(attachmentContentType('invoice.html')).toBe('application/octet-stream');
    expect(attachmentViewerKind('invoice.html')).toBe('unsupported');
  });
});

describe('isInlineRenderableAttachment', () => {
  // SECURITY. This is the gate the protocol handler asks before serving a
  // single byte. Regression: the `sarv-attachment://` scheme becoming a way to
  // get an executable, a script, an installer or live HTML into the renderer.
  it('refuses everything that could harm the system, whatever its name', () => {
    for (const name of [
      'setup.exe', 'setup.msi', 'run.bat', 'run.cmd', 'run.com', 'fake.scr',
      'go.ps1', 'go.sh', 'App.app', 'disk.dmg', 'pkg.pkg', 'lib.jar',
      'evil.js', 'evil.vbs', 'invoice.html', 'invoice.htm',
      'payload', 'payload.qqq', '.env',
    ]) {
      expect(isInlineRenderableAttachment(name)).toBe(false);
      expect(attachmentContentType(name)).toBe('application/octet-stream');
    }
  });

  // Regression: a double extension must be judged on its LAST segment, so
  // "invoice.pdf.exe" is an executable, not a PDF.
  it('judges a double extension on its final segment', () => {
    expect(isInlineRenderableAttachment('invoice.pdf.exe')).toBe(false);
    expect(isInlineRenderableAttachment('photo.png.sh')).toBe(false);
    expect(isInlineRenderableAttachment('archive.exe.png')).toBe(true);
  });

  it('allows the families the viewer renders', () => {
    for (const name of ['a.pdf', 'a.png', 'a.svg', 'a.txt', 'a.csv', 'a.mp3', 'a.mp4']) {
      expect(isInlineRenderableAttachment(name)).toBe(true);
    }
  });
});

describe('parseAttachmentNames', () => {
  // Breaks: the main process's authorization check and the UI's chip list read
  // the SAME column. If they parsed it differently, a legitimate attachment
  // would be refused — or one the UI never showed would be served.
  it('reads the JSON-array form written by the current importer', () => {
    expect(parseAttachmentNames('["a.pdf","b, with comma.png"]')).toEqual([
      'a.pdf',
      'b, with comma.png',
    ]);
  });

  // Breaks: every message imported before the JSON form has un-openable
  // attachments — the rows are still in live databases.
  it('reads the legacy comma-separated form, trimming each name', () => {
    expect(parseAttachmentNames('a.pdf, b.png ,c.txt')).toEqual(['a.pdf', 'b.png', 'c.txt']);
  });

  // Breaks: a row that merely STARTS with "[" (a filename in brackets) throws
  // out of JSON.parse and takes the whole attachment list with it.
  it('falls back when the value only looks like JSON', () => {
    expect(parseAttachmentNames('[draft] notes.txt')).toEqual(['[draft] notes.txt']);
  });

  // An empty array is an ANSWER, not a parse failure. The implementation this
  // was lifted from fell through to the comma-split here and produced a phantom
  // attachment named "[]".
  it('reads an empty JSON array as no attachments', () => {
    expect(parseAttachmentNames('[]')).toEqual([]);
    expect(parseAttachmentNames('[null, ""]')).toEqual([]);
  });

  it('treats an empty, null or undefined column as no attachments', () => {
    expect(parseAttachmentNames('')).toEqual([]);
    expect(parseAttachmentNames(null)).toEqual([]);
    expect(parseAttachmentNames(undefined)).toEqual([]);
  });
});

describe('attachment URL codec', () => {
  // Regression: the main process and the renderer building/parsing these URLs
  // differently means the viewer requests a file the handler cannot resolve —
  // or, worse, resolves to a different one.
  it('round-trips names that need escaping', () => {
    for (const filename of [
      'simple.pdf',
      'quarterly report.pdf',
      'a#b.pdf',
      'a?b=c.pdf',
      '100%25 final.pdf',
      'a+b.pdf',
      'facture-été.pdf',
      '発注書.pdf',
      'a&b;c.pdf',
    ]) {
      const ref = { emailId: 'email-1', filename };
      expect(parseAttachmentUrl(buildAttachmentUrl(ref))).toEqual({
        emailId: 'email-1',
        filename,
        accountId: undefined,
      });
    }
  });

  // Regression: an id that survives a lowercasing host would break multi-account
  // lookups. Ids live in the path precisely so their case is preserved.
  it('preserves case in ids', () => {
    const ref = { emailId: 'AbC-123', filename: 'a.pdf', accountId: 'Acct-XYZ' };
    expect(parseAttachmentUrl(buildAttachmentUrl(ref))).toEqual(ref);
  });

  it('carries accountId only when present', () => {
    expect(buildAttachmentUrl({ emailId: 'e', filename: 'a.pdf' })).not.toContain('account=');
    expect(buildAttachmentUrl({ emailId: 'e', filename: 'a.pdf', accountId: 'acc' })).toContain('account=acc');
  });

  it('uses the registered scheme', () => {
    expect(buildAttachmentUrl({ emailId: 'e', filename: 'a.pdf' }).startsWith(`${ATTACHMENT_SCHEME}://`)).toBe(true);
  });

  // Regression: a malformed URL must return null so the handler can answer 400,
  // never throw (an uncaught throw inside protocol.handle hangs the request).
  it('returns null for anything that is not a well-formed attachment URL', () => {
    expect(parseAttachmentUrl('not a url')).toBeNull();
    expect(parseAttachmentUrl('https://example.com/a/b')).toBeNull();
    expect(parseAttachmentUrl(`${ATTACHMENT_SCHEME}://elsewhere/e/a.pdf`)).toBeNull();
    expect(parseAttachmentUrl(`${ATTACHMENT_SCHEME}://attachment/only-one-segment`)).toBeNull();
    expect(parseAttachmentUrl(`${ATTACHMENT_SCHEME}://attachment/a/b/c`)).toBeNull();
    expect(parseAttachmentUrl(`${ATTACHMENT_SCHEME}://attachment//a.pdf`)).toBeNull();
    expect(parseAttachmentUrl(`${ATTACHMENT_SCHEME}://attachment/e/`)).toBeNull();
    expect(parseAttachmentUrl(`${ATTACHMENT_SCHEME}://attachment/e/%E0%A4%A`)).toBeNull();
  });
});
