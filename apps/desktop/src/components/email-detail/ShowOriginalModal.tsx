import { Code, Download, Loader2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useEmailStore } from '../../store/email-store';
import { CopyButton } from '../CopyButton';

interface ShowOriginalModalProps {
  email: any;
  onClose: () => void;
}

/**
 * Unfold an RFC822 header block into a name -> values[] map. Continuation
 * lines (starting with whitespace) are joined onto the previous header, and a
 * header that appears multiple times (Received, Authentication-Results) keeps
 * every occurrence. Only the header block (up to the first blank line) is read.
 */
function parseRawHeaders(raw: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!raw) return map;
  const headerBlock = raw.split(/\r?\n\r?\n/)[0] || '';
  const unfolded: string[] = [];
  for (const line of headerBlock.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && unfolded.length) {
      unfolded[unfolded.length - 1] += ' ' + line.trim();
    } else {
      unfolded.push(line);
    }
  }
  for (const line of unfolded) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!name) continue;
    const value = line.slice(idx + 1).trim();
    const arr = map.get(name) || [];
    arr.push(value);
    map.set(name, arr);
  }
  return map;
}

// A `Received:` value ends with `; <date>`. Pull that trailing timestamp out.
function receivedDate(value: string): Date | null {
  const i = value.lastIndexOf(';');
  if (i === -1) return null;
  const d = new Date(value.slice(i + 1).trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export function ShowOriginalModal({ email, onClose }: ShowOriginalModalProps) {
  // The true RFC822 source is not stored locally (the app discards it at
  // import, keeping only the HTML body). It is prefetched into the store the
  // moment a mail is opened, so this modal usually reads it straight from the
  // cache with no loader. On a cold miss (opened too fast / prefetch failed)
  // it kicks the fetch itself and shows a loader; if that settles with no
  // source we fall back to a reconstruction from stored fields (no auth rows).
  const cached = useEmailStore(s => s.rawSourceCache[email.id]);
  const isInflight = useEmailStore(s => s.rawSourceLoading.has(email.id));
  const prefetchRawSource = useEmailStore(s => s.prefetchRawSource);

  const rawSource = cached ?? null;
  const [settled, setSettled] = useState(false);
  const startedFor = useRef<string | null>(null);
  const sawInflight = useRef(false);

  // Reset per-email tracking when the modal is reused for a different message.
  useEffect(() => {
    startedFor.current = null;
    sawInflight.current = false;
    setSettled(false);
  }, [email.id]);

  // Cold miss: warm the cache ourselves (idempotent — no-ops if already cached
  // or in flight from the open-time prefetch).
  useEffect(() => {
    if (cached) return;
    if (startedFor.current !== email.id) {
      startedFor.current = email.id;
      prefetchRawSource(email.id);
    }
  }, [email.id, cached, prefetchRawSource]);

  // Once a fetch we observed running has ended with still no source, the
  // attempt has failed — stop showing the loader and show the fallback.
  useEffect(() => {
    if (isInflight) sawInflight.current = true;
    if (sawInflight.current && !isInflight && !cached) setSettled(true);
  }, [isInflight, cached]);

  const loading = !cached && !settled;
  const fetchError = settled && !cached ? 'server unreachable or message unavailable' : null;

  // Derived Gmail-style header summary parsed from the fetched source.
  const summary = useMemo(() => {
    const headers = parseRawHeaders(rawSource || '');
    const first = (n: string) => headers.get(n)?.[0];
    const auth = (headers.get('authentication-results') || []).join(' ; ');
    const receivedSpf = first('received-spf') || '';
    const authAndSpf = `${auth} ${receivedSpf}`;

    const spfResult = (/spf=(\w+)/i.exec(auth) || /^\s*(\w+)/.exec(receivedSpf))?.[1];
    const spfIp = (/client-ip=([0-9a-fA-F:.]+)/i.exec(authAndSpf)
      || /designates\s+([0-9a-fA-F:.]+)/i.exec(receivedSpf))?.[1];
    const dkimResult = /dkim=(\w+)/i.exec(auth)?.[1];
    const dkimDomain = /dkim=[^;]*?header\.(?:d|i)=@?([^\s;]+)/i.exec(auth)?.[1];
    const dmarcResult = /dmarc=(\w+)/i.exec(auth)?.[1];

    // Created-at + "delivered after N seconds" (Date header → final hop).
    const dateHeader = first('date');
    const sentDate = dateHeader ? new Date(dateHeader) : (email.date ? new Date(email.date * 1000) : null);
    const received = headers.get('received') || [];
    const deliveredDate = received.length ? receivedDate(received[0]) : null;
    let deliveredAfter: number | null = null;
    if (sentDate && !Number.isNaN(sentDate.getTime()) && deliveredDate) {
      const secs = Math.round((deliveredDate.getTime() - sentDate.getTime()) / 1000);
      if (secs >= 0 && secs < 60 * 60 * 24 * 7) deliveredAfter = secs;
    }

    return {
      messageId: first('message-id') || email.messageId || email.id,
      createdAt: sentDate && !Number.isNaN(sentDate.getTime()) ? sentDate.toUTCString() : null,
      deliveredAfter,
      spf: spfResult ? { result: spfResult.toUpperCase(), detail: spfIp ? `with IP ${spfIp}` : '' } : null,
      dkim: dkimResult ? { result: dkimResult.toUpperCase(), detail: dkimDomain ? `with domain ${dkimDomain}` : '' } : null,
      dmarc: dmarcResult ? { result: dmarcResult.toUpperCase(), detail: '' } : null,
    };
  }, [rawSource, email]);

  // Color the auth result: pass = green, hard failures = red, everything else
  // (none / neutral / softfail / temperror) = amber.
  const authColor = (result: string): string => {
    const k = result.toLowerCase();
    if (k === 'pass') return 'text-green-600 dark:text-green-400';
    if (k === 'fail' || k === 'permerror') return 'text-red-600 dark:text-red-400';
    return 'text-amber-600 dark:text-amber-400';
  };
  const authValue = (auth: { result: string; detail: string } | null) =>
    auth ? (
      <span>
        <span className={`font-semibold ${authColor(auth.result)}`}>{auth.result}</span>
        {auth.detail ? ` ${auth.detail}` : ''}
      </span>
    ) : null;

  const fromLabel = email.fromName ? `${email.fromName} <${email.fromAddress}>` : email.fromAddress;

  // Reconstruction shown in the raw pane when the true source is unavailable.
  const reconstructed = [
    `From: ${fromLabel}`,
    `To: ${email.toAddress}`,
    email.ccAddress ? `Cc: ${email.ccAddress}` : '',
    `Subject: ${email.subject || '(no subject)'}`,
    email.date ? `Date: ${new Date(email.date * 1000).toUTCString()}` : '',
    `Message-ID: ${email.messageId || email.id}`,
    email.contentType ? `Content-Type: ${email.contentType}` : '',
    '',
    email.rawBody || email.cleanBody || '(no content)',
  ].filter(Boolean).join('\n');

  const rawText = rawSource ?? reconstructed;

  const rows: [string, React.ReactNode][] = [
    ['Message ID', summary.messageId],
    ['Created at', summary.createdAt
      ? `${summary.createdAt}${summary.deliveredAfter != null ? ` (Delivered after ${summary.deliveredAfter} second${summary.deliveredAfter === 1 ? '' : 's'})` : ''}`
      : '—'],
    ['From', fromLabel],
    ['To', email.toAddress || '—'],
    email.ccAddress ? ['Cc', email.ccAddress] as [string, React.ReactNode] : null,
    ['Subject', email.subject || '(no subject)'],
    summary.spf ? ['SPF', authValue(summary.spf)] as [string, React.ReactNode] : null,
    summary.dkim ? ['DKIM', authValue(summary.dkim)] as [string, React.ReactNode] : null,
    summary.dmarc ? ['DMARC', authValue(summary.dmarc)] as [string, React.ReactNode] : null,
  ].filter(Boolean) as [string, React.ReactNode][];

  const downloadOriginal = () => {
    const blob = new Blob([rawText], { type: 'message/rfc822' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(email.subject || 'email').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50)}.eml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col m-4">
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Code className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold">Original Message</h3>
            {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-accent rounded transition-colors" title="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {/* Gmail-style structured header table */}
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {rows.map(([label, value], i) => (
                  <tr key={label} className={i % 2 ? 'bg-muted/30' : ''}>
                    <td className="align-top px-4 py-2.5 text-muted-foreground font-medium w-40 whitespace-nowrap">{label}</td>
                    <td className="align-top px-4 py-2.5 break-all font-mono text-xs">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!loading && fetchError && (
            <div className="text-xs text-amber-600 dark:text-amber-400">
              Could not fetch the true source ({fetchError}). Showing a reconstruction from stored data — SPF/DKIM/DMARC, the Received chain and MIME structure are unavailable until the app can reach the server.
            </div>
          )}

          {/* Full raw source */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium text-muted-foreground">
                {rawSource ? 'Raw Source (RFC822 — full headers + body):' : 'Raw Body (reconstruction):'}
              </span>
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            </div>
            {loading ? (
              <div className="flex items-center gap-2 bg-muted/50 rounded-lg p-4 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Fetching original message from server…
              </div>
            ) : (
              <pre className="bg-muted/50 rounded-lg p-4 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-[360px] overflow-y-auto">
                {rawText}
              </pre>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between gap-2 p-4 border-t border-border">
          <button
            onClick={downloadOriginal}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-primary hover:bg-accent rounded-md transition-colors disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Download Original
          </button>
          <div className="flex items-center gap-2">
            <CopyButton
              value={() => rawText}
              label="Copy to Clipboard"
              copiedLabel="Copied to clipboard"
              disabled={loading}
            />
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-md transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
