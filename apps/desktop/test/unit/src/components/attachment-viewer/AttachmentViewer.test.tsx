// @vitest-environment happy-dom
import { MAX_INLINE_TEXT_BYTES, buildAttachmentUrl } from '@sarvinbox/core/attachment-kind';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AttachmentDownloadProgress } from '../../../../../electron/preload';
import { AttachmentViewer } from '../../../../../src/components/attachment-viewer/AttachmentViewer';
import { act, fire, render, settle } from '../../../../helpers/render';

/**
 * The viewer's element mapping — which HTML element a given attachment is drawn
 * with. This is a SECURITY decision as much as a rendering one: the element is
 * the sandbox. An SVG in an <img> cannot run its embedded script; the same SVG
 * in an <iframe>/<object> can, inside our own renderer. A type the main process
 * refuses to serve inline must never get an element at all.
 */

const downloadAttachment = vi.fn();
const previewAttachment = vi.fn();
const prepareAttachmentPreview = vi.fn();
const releaseAttachmentPreview = vi.fn();
const onClose = vi.fn();
const cancelAttachmentDownload = vi.fn();
const onAttachmentDownloadProgress = vi.fn();
let progress: (value: AttachmentDownloadProgress) => void;

const view = (names: string[], initialIndex = 0) =>
  render(
    <AttachmentViewer
      emailId="email-1"
      accountId="acct-2"
      attachments={names.map((name) => ({ name, size: 2048 }))}
      initialIndex={initialIndex}
      onClose={onClose}
    />,
  );

let mounted: ReturnType<typeof render> | null = null;

/** Everything the viewer shows. It is portalled to <body>, so it is read from
 *  there rather than from the container it was mounted in. */
const viewerText = () => document.querySelector('[role="dialog"]')?.textContent ?? '';

beforeEach(() => {
  downloadAttachment.mockReset().mockResolvedValue({ success: true });
  previewAttachment.mockReset().mockResolvedValue({ success: true });
  prepareAttachmentPreview.mockReset().mockImplementation(async (emailId, filename, accountId) => ({ success: true, url: buildAttachmentUrl({ emailId, filename, accountId }) }));
  releaseAttachmentPreview.mockReset().mockResolvedValue({ success: true });
  onClose.mockReset();
  cancelAttachmentDownload.mockReset().mockResolvedValue({ success: true });
  onAttachmentDownloadProgress.mockReset().mockImplementation((callback) => { progress = callback; return vi.fn(); });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    emails: { downloadAttachment, previewAttachment, prepareAttachmentPreview, releaseAttachmentPreview, cancelAttachmentDownload, onAttachmentDownloadProgress },
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('where it is drawn', () => {
  // Breaks: drawn inline, the viewer sits inside whatever opened it. From a
  // chat bubble's attachment pill that is INSIDE the message, so a right-click
  // on the preview opened the message menu over it (see
  // AttachmentPills.chat-bubble.test.tsx), and a hovered row's stacking
  // context could put the "full-screen" overlay under its neighbours.
  it('draws into <body>, outside the element that mounted it', async () => {
    mounted = view(['photo.png']);
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.parentElement).toBe(document.body);
    expect(mounted.container.contains(dialog)).toBe(false);
  });
});

describe('element per kind', () => {
  // Breaks: the wrong element for a kind is a blank panel at best. The PDF case
  // also pins the ABSENCE of `sandbox` — Chromium's internal PDF viewer is an
  // extension that refuses to load in a sandboxed frame, so any sandbox spelling
  // (allow-scripts included) fails with ERR_BLOCKED_BY_CLIENT and the user gets a
  // blank panel. Containment for this frame lives in the protocol response
  // (extension-derived Content-Type + nosniff), asserted in attachment-protocol.
  it('draws a PDF in an un-sandboxed iframe, the only frame its viewer will run in', async () => {
    mounted = view(['report.pdf']);
    await settle();

    const frame = mounted.find('iframe')!;
    expect(frame.getAttribute('src')).toBe(
      'sarv-attachment://attachment/email-1/report.pdf?account=acct-2#toolbar=0',
    );
    expect(frame.hasAttribute('sandbox')).toBe(false);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('draws an image in <img>', async () => {
    mounted = view(['photo.png']);
    await settle();

    expect(mounted.find('img')?.getAttribute('src')).toContain('photo.png');
    expect(mounted.find('iframe')).toBeNull();
  });

  // SECURITY. Breaks: an SVG routed to an iframe/object/embed executes its
  // embedded <script> in our renderer. <img> is the only element that renders
  // SVG without running it — the classifier calls SVG an "image" for this
  // element and no other.
  it('draws an SVG in <img>, never a frame', async () => {
    mounted = view(['diagram.svg']);
    await settle();

    expect(mounted.find('img')?.getAttribute('src')).toContain('diagram.svg');
    expect(mounted.find('iframe')).toBeNull();
    expect(mounted.find('object')).toBeNull();
    expect(mounted.find('embed')).toBeNull();
  });

  // Breaks: the first open of an attachment fetches it from the mail server
  // before a byte reaches the element, so a PDF or a large image sat as a blank
  // white panel for seconds with nothing saying the app was working — the exact
  // complaint the viewer was supposed to answer. The element's own load event is
  // what clears it, so both halves are pinned.
  it.each([
    ['report.pdf', 'iframe'],
    ['photo.png', 'img'],
  ])('covers %s with a spinner until its %s loads', async (name, tag) => {
    mounted = view([name]);
    await settle();

    expect(mounted.byLabel('Loading attachment')).not.toBeNull();

    fire(mounted.find(tag), 'load');

    expect(mounted.byLabel('Loading attachment')).toBeNull();
    expect(mounted.find(tag)).not.toBeNull();
  });

  it('draws audio and video with native controls', async () => {
    mounted = view(['song.mp3']);
    await settle();
    expect(mounted.find('audio')?.hasAttribute('controls')).toBe(true);
    mounted.unmount();

    mounted = view(['clip.mp4']);
    await settle();
    expect(mounted.find('video')?.hasAttribute('controls')).toBe(true);
  });

  // Breaks: Chromium's PDF/media download controls save directly from the
  // attachment protocol, bypassing the app's trusted automatic scan workflow.
  it('hides native PDF and media downloads while retaining the app save control', async () => {
    mounted = view(['report.pdf']);
    await settle();
    expect(mounted.find('iframe')?.getAttribute('src')).toContain('#toolbar=0');
    expect(mounted.byLabel('Save a copy')).not.toBeNull();
    for (const [name, tag] of [['song.mp3', 'audio'], ['clip.mp4', 'video']]) {
      mounted.unmount();
      mounted = view([name]);
    await settle();
      expect(mounted.find(tag)?.getAttribute('controlslist')).toBe('nodownload');
      expect(mounted.find(tag)?.hasAttribute('controls')).toBe(true);
      expect(mounted.byLabel('Save a copy')).not.toBeNull();
    }
  });
});

describe('unsupported and failed', () => {
  // Breaks: an Office/archive file gets an element that renders nothing — a
  // blank panel with no explanation and no way out. v1 deliberately does not
  // render these in-app; the card is the contract.
  it('shows the fallback card for a type the viewer cannot render', async () => {
    mounted = view(['contract.docx']);
    await settle();

    expect(mounted.find('iframe')).toBeNull();
    expect(viewerText()).toContain('cannot show');
    expect(viewerText()).toContain('Save a copy');
  });

  // SECURITY — the user's constraint. Breaks: an executable gets an "Open in
  // system app" button, which asks the OS to LAUNCH it. Saving is offered (it
  // opens nothing); launching is not.
  it('offers no system-app button for a type that must never be launched', async () => {
    for (const name of ['setup.exe', 'run.sh', 'macro.vbs', 'invoice.pdf.exe']) {
      mounted?.unmount();
      mounted = view([name]);
    await settle();

      expect(viewerText(), name).toContain('Save a copy');
      expect(viewerText(), name).not.toContain('Open in system app');
      expect(mounted.byLabel('Open in system app'), name).toBeNull();
      expect(mounted.find('iframe'), name).toBeNull();
    }
  });

  // Breaks: a file whose bytes don't match its extension (a .png that isn't one,
  // a truncated fetch) shows a silent broken-image box with no way forward.
  it('falls back to the card when the element reports an error', async () => {
    mounted = view(['photo.png']);
    await settle();

    fire(mounted.find('img'), 'error');

    expect(mounted.find('img')).toBeNull();
    expect(viewerText()).toContain('could not be shown');
    fire(mounted.all('button').find((button) => button.textContent === 'Retry preview')!, 'click');
    await settle();
    expect(prepareAttachmentPreview).toHaveBeenCalledTimes(2);
    expect(mounted.find('img')).not.toBeNull();
  });
});

describe('text', () => {
  // Breaks: reading a text attachment whole puts the entire file in a JS string
  // on the renderer's main thread — and, worse, rendering it as markup would run
  // HTML that arrived inside a .txt. React escapes it; this pins that it is
  // TEXT, not children parsed from a string.
  it('fetches the text and renders it escaped', async () => {
    const html = '<script>alert(1)</script>';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new TextEncoder().encode(html))),
    );

    mounted = view(['notes.txt']);
    await settle();

    const pre = mounted.find('pre')!;
    expect(pre.textContent).toBe(html);
    expect(pre.querySelector('script')).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      'sarv-attachment://attachment/email-1/notes.txt?account=acct-2',
    );
  });

  // Breaks: a failed read leaves the spinner up forever.
  it('shows a read failure instead of spinning forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );

    mounted = view(['notes.txt']);
    await settle();

    expect(viewerText()).toContain('could not be read');
    // And the reason, verbatim: text is the only kind fetched by script, so a
    // CORS refusal and a missing file both arrive here as the same dead-end
    // message unless the cause is shown. Breaks if it is swallowed again.
    expect(viewerText()).toContain('HTTP 500');
  });

  // Breaks: a network-level refusal (the fetch rejects rather than answering)
  // rendered an empty reason line under the failure message.
  it('shows the thrown reason when the fetch never answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    mounted = view(['notes.txt']);
    await settle();

    expect(viewerText()).toContain('Failed to fetch');
  });
});

describe('navigation and dismissal', () => {
  // Breaks: the app's global shortcut handler has its own Escape branch and
  // single-letter shortcuts with no modal-open suppression, so closing the
  // viewer with Esc ALSO fired whatever Escape means underneath it. The capture
  // listener plus stopPropagation is the fix.
  it('closes on Escape without letting the key reach the app underneath', async () => {
    const underneath = vi.fn();
    document.addEventListener('keydown', underneath);
    mounted = view(['report.pdf']);
    await settle();

    fire(document.body, 'keydown', { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(underneath).not.toHaveBeenCalled();
    document.removeEventListener('keydown', underneath);
  });

  // Breaks: clicking anywhere inside the document (to select text, to press a
  // button) closes the viewer, because the backdrop handler isn't scoped.
  it('closes on a backdrop click but not on a click inside the panel', async () => {
    mounted = view(['report.pdf']);
    await settle();

    fire(mounted.find('[role="dialog"]'), 'click');
    expect(onClose).toHaveBeenCalledTimes(1);

    fire(mounted.find('iframe'), 'click');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Breaks: the arrows stop moving between an email's attachments, or wrap the
  // wrong way at the ends.
  it('moves between attachments with the arrow keys, wrapping at the ends', async () => {
    mounted = view(['a.png', 'b.png', 'c.png'], 0);
    await settle();

    fire(document.body, 'keydown', { key: 'ArrowRight' });
    await settle();
    expect(mounted.find('img')?.getAttribute('src')).toContain('b.png');

    fire(document.body, 'keydown', { key: 'ArrowLeft' });
    await settle();
    fire(document.body, 'keydown', { key: 'ArrowLeft' });
    await settle();
    expect(mounted.find('img')?.getAttribute('src')).toContain('c.png');
    fire(mounted.byLabel('Previous attachment'), 'click');
    await settle();
    expect(mounted.find('img')?.getAttribute('src')).toContain('b.png');
  });

  // Breaks: seeking a video with the keyboard jumps to the NEXT attachment
  // instead of scrubbing — the arrows belong to the media element while it has
  // focus.
  it('leaves the arrow keys alone while a media element has focus', async () => {
    mounted = view(['clip.mp4', 'b.png']);
    await settle();

    fire(mounted.find('video'), 'keydown', { key: 'ArrowRight' });

    expect(mounted.find('video')).not.toBeNull();
    expect(mounted.find('img')).toBeNull();
  });

  // Breaks: the header's position indicator is how the user knows there is more
  // than one attachment at all.
  it('shows the position when there is more than one attachment', async () => {
    mounted = view(['a.png', 'b.png', 'c.png'], 1);
    await settle();

    expect(viewerText()).toContain('2 of 3');
    expect(mounted.byLabel('Next attachment')).not.toBeNull();
  });

  it('hides the navigation for a single attachment', async () => {
    mounted = view(['a.png']);
    await settle();

    expect(viewerText()).not.toContain(' of ');
    expect(mounted.byLabel('Next attachment')).toBeNull();
  });
});

describe('header actions', () => {
  // Breaks: the fullscreen viewer conceals the scanning state and cancellation
  // controls, although its Download button uses the same automatic scan gate.
  it('shows host scan progress and cancellation in the viewer header', async () => {
    let release!: (value: unknown) => void;
    downloadAttachment.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    mounted = view(['photo.png']);
    await settle();
    fire(mounted.byLabel('Save a copy'), 'click');
    const requestId = downloadAttachment.mock.calls[0][3];
    act(() => { progress({ requestId, phase: 'scanning' }); });
    expect(viewerText()).toContain('Scanning…');
    expect((mounted.byLabel('Open in system app') as HTMLButtonElement).disabled).toBe(true);
    fire(mounted.byLabel('Cancel download of photo.png'), 'click');
    await settle();
    expect(cancelAttachmentDownload).toHaveBeenCalledWith(requestId);
    release({ success: false, error: 'Download cancelled.' });
    await settle();
    expect(viewerText()).toContain('Download cancelled.');
    expect(mounted.byLabel('Cancel download of photo.png')).toBeNull();
  });

  // Breaks: the viewer's Save/Open buttons stop carrying the account, so in All
  // Inboxes they act on the wrong account (or fail with "Email not found").
  it('passes the owning account to save and open', async () => {
    mounted = view(['report.pdf']);
    await settle();

    fire(mounted.byLabel('Save a copy'), 'click');
    // One at a time: while a save is in flight both buttons are disabled, which
    // is itself the guard against double-firing a native dialog.
    await settle();
    fire(mounted.byLabel('Open in system app'), 'click');
    await settle();

    expect(downloadAttachment).toHaveBeenCalledWith('email-1', 'report.pdf', 'acct-2', expect.any(String));
    expect(previewAttachment).toHaveBeenCalledWith('email-1', 'report.pdf', 'acct-2', expect.any(String));
  });

  // Breaks: every icon-only control needs a name for screen readers (and the
  // repo's tooltip convention) — without one the header is a row of mystery
  // glyphs.
  it('labels every icon-only control', async () => {
    mounted = view(['a.png', 'b.png']);
    await settle();

    for (const label of [
      'Previous attachment',
      'Next attachment',
      'Save a copy',
      'Close attachment viewer',
    ]) {
      expect(mounted.byLabel(label), label).not.toBeNull();
    }
  });
});

describe('presentation details', () => {
  // Breaks: an oversized text file is read whole into a JS string on the
  // renderer's main thread. It is capped instead — and the user has to be told,
  // or they read a silently truncated document as if it were complete.
  it('caps a large text file and says so', async () => {
    const oversized = new Uint8Array(MAX_INLINE_TEXT_BYTES + 10).fill(0x61);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(oversized)),
    );

    mounted = view(['huge.log']);
    await settle();

    expect(viewerText()).toContain('Showing the first 2 MB');
    expect(mounted.find('pre')!.textContent!.length).toBe(MAX_INLINE_TEXT_BYTES);
  });

  // Breaks: a large image is only ever shown shrunk to fit, with no way to see
  // it at full resolution (a scanned invoice becomes unreadable).
  it('toggles an image between fit-to-window and actual size', async () => {
    mounted = view(['photo.png']);
    await settle();

    expect(mounted.find('img')!.className).toContain('object-contain');
    fire(mounted.byLabel('Actual size'), 'click');

    expect(mounted.find('img')!.className).toContain('max-w-none');
    expect(mounted.byLabel('Fit to window')).not.toBeNull();
  });

  // Breaks: the fallback card's buttons are decoration — the only two things a
  // user can still do with an unrenderable file stop working.
  it('saves and opens from the fallback card', async () => {
    mounted = view(['contract.docx']);
    await settle();

    const [save, open] = mounted.all('button').filter((b) => /Save a copy|Open in system app/.test(b.textContent ?? ''));
    fire(save, 'click');
    await settle();
    fire(open, 'click');
    await settle();

    expect(downloadAttachment).toHaveBeenCalledWith('email-1', 'contract.docx', 'acct-2', expect.any(String));
    expect(previewAttachment).toHaveBeenCalledWith('email-1', 'contract.docx', 'acct-2', expect.any(String));
  });

  // Breaks: the size line shows "NaN B" or the literal 'Unknown' that legacy
  // rows carry, because callers pass bytes, a pre-formatted string, or nothing.
  it('accepts a size as bytes, as a formatted string, or missing', async () => {
    const withSize = (size: unknown) =>
      render(
        <AttachmentViewer
          emailId="email-1"
          attachments={[{ name: 'a.png', size: size as number }]}
          initialIndex={0}
          onClose={onClose}
        />,
      );

    mounted = withSize(2048);
    await settle();
    expect(viewerText()).toContain('2.0 KB');
    mounted.unmount();

    mounted = withSize('1.2 MB');
    await settle();
    expect(viewerText()).toContain('1.2 MB');
    mounted.unmount();

    mounted = withSize('Unknown');
    await settle();
    expect(viewerText()).not.toContain('Unknown');
    mounted.unmount();

    mounted = withSize(undefined);
    await settle();
    expect(viewerText()).toBe('a.pngImage');
  });

  // Breaks: an out-of-range index (a stale click after the list changed) throws
  // on `attachments[index].name` instead of simply showing the nearest one.
  it('clamps an initial index outside the list', async () => {
    mounted = view(['a.png', 'b.png'], 99);
    await settle();

    expect(mounted.find('img')?.getAttribute('src')).toContain('b.png');
  });
});


describe('scan before viewing', () => {
  // Breaks: accepting the host's missing-setup warning opens a PDF without
  // keeping its unscanned state visible, or renders before acceptance finishes.
  it('opens the accepted unscanned host preview and keeps its warning visible', async () => {
    let release!: (result: unknown) => void;
    prepareAttachmentPreview.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    mounted = view(['report.pdf']);
    expect(mounted.find('iframe')).toBeNull();
    expect(viewerText()).not.toContain('Not scanned for viruses.');
    release({ success: true, notScanned: true, url: 'sarv-attachment://attachment/email-1/report.pdf?account=acct-2&lease=unscanned' });
    await settle();
    expect(mounted.find('iframe')?.getAttribute('src')).toContain('lease=unscanned');
    expect(viewerText()).toContain('Not scanned for viruses.');
    expect(viewerText()).not.toContain('Scanning…');
    expect(mounted.byLabel('Save a copy')).not.toBeNull();
    expect(mounted.byLabel('Cancel preview of report.pdf')).toBeNull();
  });

  // Breaks: the viewer gives PDF/image/media or text fetch an attachment URL
  // while the trusted host is still downloading/scanning its selected bytes.
  it.each([
    ['report.pdf', 'iframe'], ['photo.png', 'img'], ['notes.txt', 'pre'],
    ['song.mp3', 'audio'], ['clip.mp4', 'video'],
  ])('keeps %s out of its %s until the host returns a protected URL', async (name, tag) => {
    let release!: (result: unknown) => void;
    prepareAttachmentPreview.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const fetchSpy = vi.fn(async () => new Response('safe text'));
    vi.stubGlobal('fetch', fetchSpy);
    mounted = view([name]);
    const requestId = prepareAttachmentPreview.mock.calls[0][3];
    expect(mounted.find(tag)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(viewerText()).toContain('Downloading…');
    act(() => progress({ requestId, phase: 'scanning' }));
    expect(viewerText()).toContain('Scanning…');
    expect(mounted.find(tag)).toBeNull();
    release({ success: true, url: `sarv-attachment://attachment/email-1/${name}?account=acct-2&lease=verified` });
    await settle();
    expect(mounted.find(tag)).not.toBeNull();
    const elementUrl = mounted.find(tag)?.getAttribute('src') ?? (fetchSpy.mock.calls[0] as unknown[])?.[0];
    if (tag !== 'pre') expect(elementUrl).toContain('lease=verified');
    else expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('lease=verified'));
    expect(downloadAttachment).not.toHaveBeenCalled();
    expect(previewAttachment).not.toHaveBeenCalled();
  });

  // Breaks: a threat/incomplete scan is transformed into a broken preview with
  // hidden reason, or Retry fails to ask for a new clean host authorization.
  it.each([
    'Download blocked: ClamAV detected a threat.',
    'Download blocked: the attachment could not be fully scanned.',
    'Configure ClamAV Scan before downloading attachments.',
  ])('blocks bytes with a visible reason and allows retry (%s)', async (error) => {
    prepareAttachmentPreview.mockResolvedValueOnce({ success: false, error });
    mounted = view(['report.pdf']);
    await settle();
    expect(mounted.find('iframe')).toBeNull();
    expect(mounted.find('[role="alert"]')?.textContent).toBe(error);
    const firstRequestId = prepareAttachmentPreview.mock.calls[0][3];
    fire(mounted.all('button').find((button) => button.textContent === 'Retry preview')!, 'click');
    await settle();
    expect(prepareAttachmentPreview).toHaveBeenCalledTimes(2);
    expect(prepareAttachmentPreview.mock.calls[1][3]).not.toBe(firstRequestId);
    expect(mounted.find('iframe')).not.toBeNull();
    expect(mounted.find('[role="alert"]')).toBeNull();
  });

  // Breaks: closing/navigating retains clean bytes in the main process, or a
  // slow earlier scan resolves into the next attachment's viewer.
  it('cancels navigation, releases stale results and uses only the current URL', async () => {
    let releaseFirst!: (result: unknown) => void;
    prepareAttachmentPreview.mockReturnValueOnce(new Promise((resolve) => { releaseFirst = resolve; }));
    mounted = view(['old.pdf', 'current.png']);
    const firstRequestId = prepareAttachmentPreview.mock.calls[0][3];
    fire(mounted.byLabel('Next attachment'), 'click');
    await settle();
    expect(cancelAttachmentDownload).toHaveBeenCalledWith(firstRequestId);
    expect(mounted.find('img')?.getAttribute('src')).toContain('current.png');
    releaseFirst({ success: true, url: 'sarv-attachment://attachment/email-1/old.pdf?lease=stale' });
    await settle();
    expect(releaseAttachmentPreview).toHaveBeenCalledWith('sarv-attachment://attachment/email-1/old.pdf?lease=stale');
    expect(mounted.find('iframe')).toBeNull();
    expect(mounted.find('img')?.getAttribute('src')).toContain('current.png');
    mounted.unmount();
    expect(releaseAttachmentPreview).toHaveBeenCalledWith('sarv-attachment://attachment/email-1/current.png?account=acct-2');
  });

  // Breaks: cancellation releases the spinner but still mounts an unverified
  // frame, or closing after cancellation starts a second scan.
  it('shows preview cancellation without rendering or launching', async () => {
    let release!: (result: unknown) => void;
    prepareAttachmentPreview.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    mounted = view(['report.pdf']);
    const requestId = prepareAttachmentPreview.mock.calls[0][3];
    fire(mounted.byLabel('Cancel preview of report.pdf'), 'click');
    await settle();
    expect(cancelAttachmentDownload).toHaveBeenCalledWith(requestId);
    release({ success: false, error: 'Download cancelled.' });
    await settle();
    expect(viewerText()).toContain('Preview cancelled.');
    expect(mounted.find('iframe')).toBeNull();
    expect(previewAttachment).not.toHaveBeenCalled();
    expect(releaseAttachmentPreview).not.toHaveBeenCalled();
  });

  // Breaks: unsupported docs get a hidden prefetch/upload simply by opening a
  // fallback card. The explicit system-open control is their scan boundary.
  it('does not fetch unsupported documents until the user chooses system opening', async () => {
    mounted = view(['contract.docx']);
    expect(prepareAttachmentPreview).not.toHaveBeenCalled();
    fire(mounted.byLabel('Open in system app'), 'click');
    await settle();
    expect(previewAttachment).toHaveBeenCalledWith('email-1', 'contract.docx', 'acct-2', expect.any(String));
    expect(prepareAttachmentPreview).not.toHaveBeenCalled();
  });
});
