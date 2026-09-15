// @vitest-environment happy-dom
import { MAX_INLINE_TEXT_BYTES } from '@sarvinbox/core/attachment-kind';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AttachmentViewer } from '../../../../../src/components/attachment-viewer/AttachmentViewer';
import { fire, render, settle } from '../../../../helpers/render';

/**
 * The viewer's element mapping — which HTML element a given attachment is drawn
 * with. This is a SECURITY decision as much as a rendering one: the element is
 * the sandbox. An SVG in an <img> cannot run its embedded script; the same SVG
 * in an <iframe>/<object> can, inside our own renderer. A type the main process
 * refuses to serve inline must never get an element at all.
 */

const downloadAttachment = vi.fn();
const previewAttachment = vi.fn();
const onClose = vi.fn();

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

beforeEach(() => {
  downloadAttachment.mockReset().mockResolvedValue({ success: true });
  previewAttachment.mockReset().mockResolvedValue({ success: true });
  onClose.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    emails: { downloadAttachment, previewAttachment },
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('element per kind', () => {
  // Breaks: the wrong element for a kind is a blank panel at best. The PDF case
  // also pins the ABSENCE of `sandbox` — Chromium's internal PDF viewer is an
  // extension that refuses to load in a sandboxed frame, so any sandbox spelling
  // (allow-scripts included) fails with ERR_BLOCKED_BY_CLIENT and the user gets a
  // blank panel. Containment for this frame lives in the protocol response
  // (extension-derived Content-Type + nosniff), asserted in attachment-protocol.
  it('draws a PDF in an un-sandboxed iframe, the only frame its viewer will run in', () => {
    mounted = view(['report.pdf']);

    const frame = mounted.find('iframe')!;
    expect(frame.getAttribute('src')).toBe(
      'sarv-attachment://attachment/email-1/report.pdf?account=acct-2',
    );
    expect(frame.hasAttribute('sandbox')).toBe(false);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  });

  it('draws an image in <img>', () => {
    mounted = view(['photo.png']);

    expect(mounted.find('img')?.getAttribute('src')).toContain('photo.png');
    expect(mounted.find('iframe')).toBeNull();
  });

  // SECURITY. Breaks: an SVG routed to an iframe/object/embed executes its
  // embedded <script> in our renderer. <img> is the only element that renders
  // SVG without running it — the classifier calls SVG an "image" for this
  // element and no other.
  it('draws an SVG in <img>, never a frame', () => {
    mounted = view(['diagram.svg']);

    expect(mounted.find('img')?.getAttribute('src')).toContain('diagram.svg');
    expect(mounted.find('iframe')).toBeNull();
    expect(mounted.find('object')).toBeNull();
    expect(mounted.find('embed')).toBeNull();
  });

  it('draws audio and video with native controls', () => {
    mounted = view(['song.mp3']);
    expect(mounted.find('audio')?.hasAttribute('controls')).toBe(true);
    mounted.unmount();

    mounted = view(['clip.mp4']);
    expect(mounted.find('video')?.hasAttribute('controls')).toBe(true);
  });
});

describe('unsupported and failed', () => {
  // Breaks: an Office/archive file gets an element that renders nothing — a
  // blank panel with no explanation and no way out. v1 deliberately does not
  // render these in-app; the card is the contract.
  it('shows the fallback card for a type the viewer cannot render', () => {
    mounted = view(['contract.docx']);

    expect(mounted.find('iframe')).toBeNull();
    expect(mounted.container.textContent).toContain('cannot show');
    expect(mounted.container.textContent).toContain('Save a copy');
  });

  // SECURITY — the user's constraint. Breaks: an executable gets an "Open in
  // system app" button, which asks the OS to LAUNCH it. Saving is offered (it
  // opens nothing); launching is not.
  it('offers no system-app button for a type that must never be launched', () => {
    for (const name of ['setup.exe', 'run.sh', 'macro.vbs', 'invoice.pdf.exe']) {
      mounted?.unmount();
      mounted = view([name]);

      expect(mounted.container.textContent, name).toContain('Save a copy');
      expect(mounted.container.textContent, name).not.toContain('Open in system app');
      expect(mounted.byLabel('Open in system app'), name).toBeNull();
      expect(mounted.find('iframe'), name).toBeNull();
    }
  });

  // Breaks: a file whose bytes don't match its extension (a .png that isn't one,
  // a truncated fetch) shows a silent broken-image box with no way forward.
  it('falls back to the card when the element reports an error', () => {
    mounted = view(['photo.png']);

    fire(mounted.find('img'), 'error');

    expect(mounted.find('img')).toBeNull();
    expect(mounted.container.textContent).toContain('could not be shown');
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

    expect(mounted.container.textContent).toContain('could not be read');
    // And the reason, verbatim: text is the only kind fetched by script, so a
    // CORS refusal and a missing file both arrive here as the same dead-end
    // message unless the cause is shown. Breaks if it is swallowed again.
    expect(mounted.container.textContent).toContain('HTTP 500');
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

    expect(mounted.container.textContent).toContain('Failed to fetch');
  });
});

describe('navigation and dismissal', () => {
  // Breaks: the app's global shortcut handler has its own Escape branch and
  // single-letter shortcuts with no modal-open suppression, so closing the
  // viewer with Esc ALSO fired whatever Escape means underneath it. The capture
  // listener plus stopPropagation is the fix.
  it('closes on Escape without letting the key reach the app underneath', () => {
    const underneath = vi.fn();
    document.addEventListener('keydown', underneath);
    mounted = view(['report.pdf']);

    fire(document.body, 'keydown', { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(underneath).not.toHaveBeenCalled();
    document.removeEventListener('keydown', underneath);
  });

  // Breaks: clicking anywhere inside the document (to select text, to press a
  // button) closes the viewer, because the backdrop handler isn't scoped.
  it('closes on a backdrop click but not on a click inside the panel', () => {
    mounted = view(['report.pdf']);

    fire(mounted.find('[role="dialog"]'), 'click');
    expect(onClose).toHaveBeenCalledTimes(1);

    fire(mounted.find('iframe'), 'click');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Breaks: the arrows stop moving between an email's attachments, or wrap the
  // wrong way at the ends.
  it('moves between attachments with the arrow keys, wrapping at the ends', () => {
    mounted = view(['a.png', 'b.png', 'c.png'], 0);

    fire(document.body, 'keydown', { key: 'ArrowRight' });
    expect(mounted.find('img')?.getAttribute('src')).toContain('b.png');

    fire(document.body, 'keydown', { key: 'ArrowLeft' });
    fire(document.body, 'keydown', { key: 'ArrowLeft' });
    expect(mounted.find('img')?.getAttribute('src')).toContain('c.png');
  });

  // Breaks: seeking a video with the keyboard jumps to the NEXT attachment
  // instead of scrubbing — the arrows belong to the media element while it has
  // focus.
  it('leaves the arrow keys alone while a media element has focus', () => {
    mounted = view(['clip.mp4', 'b.png']);

    fire(mounted.find('video'), 'keydown', { key: 'ArrowRight' });

    expect(mounted.find('video')).not.toBeNull();
    expect(mounted.find('img')).toBeNull();
  });

  // Breaks: the header's position indicator is how the user knows there is more
  // than one attachment at all.
  it('shows the position when there is more than one attachment', () => {
    mounted = view(['a.png', 'b.png', 'c.png'], 1);

    expect(mounted.container.textContent).toContain('2 of 3');
    expect(mounted.byLabel('Next attachment')).not.toBeNull();
  });

  it('hides the navigation for a single attachment', () => {
    mounted = view(['a.png']);

    expect(mounted.container.textContent).not.toContain(' of ');
    expect(mounted.byLabel('Next attachment')).toBeNull();
  });
});

describe('header actions', () => {
  // Breaks: the viewer's Save/Open buttons stop carrying the account, so in All
  // Inboxes they act on the wrong account (or fail with "Email not found").
  it('passes the owning account to save and open', async () => {
    mounted = view(['report.pdf']);

    fire(mounted.byLabel('Save a copy'), 'click');
    // One at a time: while a save is in flight both buttons are disabled, which
    // is itself the guard against double-firing a native dialog.
    await settle();
    fire(mounted.byLabel('Open in system app'), 'click');
    await settle();

    expect(downloadAttachment).toHaveBeenCalledWith('email-1', 'report.pdf', 'acct-2');
    expect(previewAttachment).toHaveBeenCalledWith('email-1', 'report.pdf', 'acct-2');
  });

  // Breaks: every icon-only control needs a name for screen readers (and the
  // repo's tooltip convention) — without one the header is a row of mystery
  // glyphs.
  it('labels every icon-only control', () => {
    mounted = view(['a.png', 'b.png']);

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

    expect(mounted.container.textContent).toContain('Showing the first 2 MB');
    expect(mounted.find('pre')!.textContent!.length).toBe(MAX_INLINE_TEXT_BYTES);
  });

  // Breaks: a large image is only ever shown shrunk to fit, with no way to see
  // it at full resolution (a scanned invoice becomes unreadable).
  it('toggles an image between fit-to-window and actual size', () => {
    mounted = view(['photo.png']);

    expect(mounted.find('img')!.className).toContain('object-contain');
    fire(mounted.byLabel('Actual size'), 'click');

    expect(mounted.find('img')!.className).toContain('max-w-none');
    expect(mounted.byLabel('Fit to window')).not.toBeNull();
  });

  // Breaks: the fallback card's buttons are decoration — the only two things a
  // user can still do with an unrenderable file stop working.
  it('saves and opens from the fallback card', async () => {
    mounted = view(['contract.docx']);

    const [save, open] = mounted.all('button').filter((b) => /Save a copy|Open in system app/.test(b.textContent ?? ''));
    fire(save, 'click');
    await settle();
    fire(open, 'click');
    await settle();

    expect(downloadAttachment).toHaveBeenCalledWith('email-1', 'contract.docx', 'acct-2');
    expect(previewAttachment).toHaveBeenCalledWith('email-1', 'contract.docx', 'acct-2');
  });

  // Breaks: the size line shows "NaN B" or the literal 'Unknown' that legacy
  // rows carry, because callers pass bytes, a pre-formatted string, or nothing.
  it('accepts a size as bytes, as a formatted string, or missing', () => {
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
    expect(mounted.container.textContent).toContain('2.0 KB');
    mounted.unmount();

    mounted = withSize('1.2 MB');
    expect(mounted.container.textContent).toContain('1.2 MB');
    mounted.unmount();

    mounted = withSize('Unknown');
    expect(mounted.container.textContent).not.toContain('Unknown');
    mounted.unmount();

    mounted = withSize(undefined);
    expect(mounted.container.textContent).toBe('a.pngImage');
  });

  // Breaks: an out-of-range index (a stale click after the list changed) throws
  // on `attachments[index].name` instead of simply showing the nearest one.
  it('clamps an initial index outside the list', () => {
    mounted = view(['a.png', 'b.png'], 99);

    expect(mounted.find('img')?.getAttribute('src')).toContain('b.png');
  });
});
