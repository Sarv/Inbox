import {
  MAX_INLINE_TEXT_BYTES,
  attachmentViewerKind,
  buildAttachmentUrl,
  isPreviewableAttachment,
  type AttachmentViewerKind,
} from '@sarvinbox/core/attachment-kind';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Loader2,
  Maximize2,
  Minimize2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';


import { getFileIcon, getFileType } from '../email-detail/utils';
import { Tooltip } from '../Tooltip';

import { useAttachmentActions } from './useAttachmentActions';

/**
 * The in-app attachment viewer.
 *
 * Everything here reads from ONE `sarv-attachment://` URL, which the main
 * process serves with a `Content-Type` derived from the same allow-list
 * `attachmentViewerKind` consults. The element and the type are therefore always
 * two views of one decision — the renderer never picks an element for a file the
 * main process would refuse to serve inline.
 */

export interface ViewerAttachment {
  name: string;
  /** Bytes, or an already-formatted label — callers have both shapes today. */
  size?: number | string | null;
}

interface AttachmentViewerProps {
  emailId: string;
  accountId?: string;
  attachments: ViewerAttachment[];
  /** Index of the attachment to show first. */
  initialIndex: number;
  onClose: () => void;
}

/** Human-readable size. Local (and tiny) because the core barrel's `formatBytes`
 *  is not renderer-importable — the barrel pulls Node-only transports. */
function formatSize(size?: number | string | null): string {
  // Some callers already formatted it ("1.2 MB"), some pass raw bytes, and
  // legacy rows have no size at all and pass the literal 'Unknown'.
  if (typeof size === 'string') return size === 'Unknown' ? '' : size;
  const bytes = size;
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function AttachmentViewer({
  emailId,
  accountId,
  attachments,
  initialIndex,
  onClose,
}: AttachmentViewerProps) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(initialIndex, 0), Math.max(attachments.length - 1, 0)),
  );
  const { isBusy, saveCopy, openInSystemApp } = useAttachmentActions();

  const current = attachments[index];
  const filename = current?.name ?? '';
  const kind: AttachmentViewerKind = useMemo(() => attachmentViewerKind(filename), [filename]);
  const url = useMemo(
    () => (filename ? buildAttachmentUrl({ emailId, filename, accountId }) : ''),
    [emailId, filename, accountId],
  );

  // `failed` is set by each element's onError. A file whose bytes don't match
  // its extension (a .png that is really something else, a truncated fetch)
  // otherwise shows a silent broken box with no way forward — this turns it into
  // the same fallback card an unsupported type gets.
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);

  const goTo = useCallback(
    (next: number) => {
      if (attachments.length === 0) return;
      setIndex(((next % attachments.length) + attachments.length) % attachments.length);
    },
    [attachments.length],
  );

  // Capture phase, and stopPropagation: the app's global shortcut handler has its
  // own Escape branch (and single-letter shortcuts like `e`/`r`) with no
  // modal-open suppression. Without capturing first, closing the viewer with Esc
  // also fired whatever Escape means underneath it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (attachments.length > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        // Leave the arrows alone while a media element has focus, so seeking a
        // video with the keyboard doesn't skip to the next attachment instead.
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === 'VIDEO' || tag === 'AUDIO') return;
        event.preventDefault();
        event.stopPropagation();
        goTo(index + (event.key === 'ArrowLeft' ? -1 : 1));
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose, goTo, index, attachments.length]);

  if (!current) return null;

  const busy = isBusy(emailId, filename);
  const canOpenExternally = isPreviewableAttachment(filename);

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col bg-black/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Attachment: ${filename}`}
    >
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium" title={filename}>
              {filename}
            </div>
            <div className="text-xs text-muted-foreground">
              {[getFileType(filename), formatSize(current.size)].filter(Boolean).join(' · ')}
              {attachments.length > 1 ? ` · ${index + 1} of ${attachments.length}` : ''}
            </div>
          </div>

          {attachments.length > 1 && (
            <div className="flex items-center gap-1">
              <Tooltip content="Previous attachment" delayMs={40}>
                <button
                  onClick={() => goTo(index - 1)}
                  aria-label="Previous attachment"
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
              </Tooltip>
              <Tooltip content="Next attachment" delayMs={40}>
                <button
                  onClick={() => goTo(index + 1)}
                  aria-label="Next attachment"
                  className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
          )}

          <Tooltip content="Save a copy" delayMs={40}>
            <button
              onClick={() => saveCopy({ emailId, filename, accountId })}
              disabled={busy}
              aria-label="Save a copy"
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </button>
          </Tooltip>

          {canOpenExternally && (
            <Tooltip content="Open in system app" delayMs={40}>
              <button
                onClick={() => openInSystemApp({ emailId, filename, accountId })}
                disabled={busy}
                aria-label="Open in system app"
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <ExternalLink className="h-4 w-4" />
              </button>
            </Tooltip>
          )}

          <Tooltip content="Close" shortcut="Esc" delayMs={40}>
            <button
              onClick={onClose}
              aria-label="Close attachment viewer"
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        <div className="flex-1 overflow-auto bg-muted/30">
          {failed || kind === 'unsupported' ? (
            <UnsupportedCard
              filename={filename}
              failed={failed}
              canOpenExternally={canOpenExternally}
              busy={busy}
              onSave={() => saveCopy({ emailId, filename, accountId })}
              onOpenExternally={() => openInSystemApp({ emailId, filename, accountId })}
            />
          ) : (
            <AttachmentBody
              kind={kind}
              url={url}
              filename={filename}
              onError={() => setFailed(true)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function AttachmentBody({
  kind,
  url,
  filename,
  onError,
}: {
  kind: AttachmentViewerKind;
  url: string;
  filename: string;
  onError: () => void;
}) {
  if (kind === 'pdf') {
    return (
      // Chromium's own PDF viewer, and it will not run inside a sandboxed frame:
      // ANY `sandbox` attribute — `allow-scripts` included — fails the load with
      // ERR_BLOCKED_BY_CLIENT and leaves the panel blank, because the internal
      // viewer is an extension that needs an origin of its own. Verified on a
      // real 499 KB PDF: sandboxed frames were refused, the plain frame rendered.
      //
      // What contains this frame is the RESPONSE, not the attribute. The protocol
      // handler derives `Content-Type` from the sanitized extension alone (never
      // the sender's declared type) and sends `X-Content-Type-Options: nosniff`,
      // so a `.pdf` that actually carries HTML is still handed to the PDF plugin
      // instead of being parsed as a document — this frame cannot become a
      // script-executing one. Only the `pdf` kind reaches here; every other kind
      // renders through <img>/<pre>/<audio>/<video>, never a frame.
      <iframe
        src={url}
        title={filename}
        referrerPolicy="no-referrer"
        className="h-full w-full border-0 bg-white"
        onError={onError}
      />
    );
  }

  if (kind === 'image') return <ImageBody url={url} filename={filename} onError={onError} />;
  if (kind === 'text') return <TextBody url={url} />;

  if (kind === 'audio') {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <audio src={url} controls className="w-full max-w-xl" onError={onError} />
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center bg-black">
      <video src={url} controls className="max-h-full max-w-full" onError={onError} />
    </div>
  );
}

function ImageBody({
  url,
  filename,
  onError,
}: {
  url: string;
  filename: string;
  onError: () => void;
}) {
  const [actualSize, setActualSize] = useState(false);
  return (
    <div className="relative flex h-full items-center justify-center overflow-auto p-4">
      <Tooltip content={actualSize ? 'Fit to window' : 'Actual size'} delayMs={40}>
        <button
          onClick={() => setActualSize((prev) => !prev)}
          aria-label={actualSize ? 'Fit to window' : 'Actual size'}
          className="absolute right-3 top-3 z-10 rounded bg-background/80 p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {actualSize ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </Tooltip>
      {/* <img> and not <object>/<iframe>: an SVG rendered through <img> cannot
          run its embedded scripts. The classifier calls SVG an image precisely
          because this element is the one that renders it. */}
      <img
        src={url}
        alt={filename}
        onError={onError}
        className={actualSize ? 'max-w-none' : 'max-h-full max-w-full object-contain'}
      />
    </div>
  );
}

function TextBody({ url }: { url: string }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; text: string; truncated: boolean }
    | { status: 'error'; reason: string }
  >({ status: 'loading' });
  // Guards against a slow fetch resolving after the user moved to the next
  // attachment and writing the wrong file's text into the panel.
  const requestedUrl = useRef(url);

  useEffect(() => {
    requestedUrl.current = url;
    setState({ status: 'loading' });
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Text is the one kind read whole rather than streamed, so it is the one
        // kind that needs a size cap: an unbounded read puts the entire file in a
        // JS string on the renderer's main thread.
        const buffer = await response.arrayBuffer();
        const truncated = buffer.byteLength > MAX_INLINE_TEXT_BYTES;
        const slice = truncated ? buffer.slice(0, MAX_INLINE_TEXT_BYTES) : buffer;
        const text = new TextDecoder('utf-8').decode(slice);
        if (!cancelled && requestedUrl.current === url) {
          setState({ status: 'ready', text, truncated });
        }
      } catch (error) {
        // Carry the reason, don't swallow it. Text is the only kind fetched by
        // script rather than loaded by an element, so it is the only one whose
        // failure has no browser-visible trace — a bare "could not be read"
        // left a real CORS refusal indistinguishable from a missing file.
        const reason = error instanceof Error ? error.message : String(error);
        if (!cancelled && requestedUrl.current === url) setState({ status: 'error', reason });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (state.status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-sm text-muted-foreground">
        <span>This file could not be read.</span>
        <span className="font-mono text-xs opacity-70">{state.reason}</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      {state.truncated && (
        <div className="mb-3 rounded border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          Showing the first {Math.round(MAX_INLINE_TEXT_BYTES / (1024 * 1024))} MB. Save a copy to
          read the whole file.
        </div>
      )}
      {/* Rendered as a text node, never as markup: React escapes it, so a text
          attachment containing HTML is shown, not executed. */}
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {state.text}
      </pre>
    </div>
  );
}

function UnsupportedCard({
  filename,
  failed,
  canOpenExternally,
  busy,
  onSave,
  onOpenExternally,
}: {
  filename: string;
  failed: boolean;
  canOpenExternally: boolean;
  busy: boolean;
  onSave: () => void;
  onOpenExternally: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="rounded-lg bg-muted/50 p-4">{getFileIcon(filename)}</div>
      <div className="max-w-sm text-sm text-muted-foreground">
        {failed
          ? 'This file could not be shown in Sarv Inbox.'
          : `Sarv Inbox cannot show ${getFileType(filename)} files.`}
        {canOpenExternally
          ? ' Open it in an app on your computer, or save a copy.'
          : ' Save a copy to open it yourself.'}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onSave}
          disabled={busy}
          className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          <span>Save a copy</span>
        </button>
        {canOpenExternally && (
          <button
            onClick={onOpenExternally}
            disabled={busy}
            className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>Open in system app</span>
          </button>
        )}
      </div>
    </div>
  );
}
