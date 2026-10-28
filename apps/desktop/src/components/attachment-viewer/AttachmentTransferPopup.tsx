import {
  ArrowDownToLine,
  ArrowUpToLine,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  File,
  FolderOpen,
  Info,
  Loader2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Tooltip } from '../Tooltip';

import type { AttachmentTransfer } from './attachment-transfer-types';
import './attachment-transfer.css';

export interface AttachmentTransferPopupProps {
  transfers: AttachmentTransfer[];
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  onPreview: (id: string) => void;
  onOpenFile: (id: string) => void;
  onShowFolder: (id: string) => void;
  onRetry: (id: string) => void;
  onMinimize: () => void;
}

const SECURITY_DETAILS = 'With scanning enabled, the attachment is uploaded to the scanning server and checked before it is opened on your device. Server-side checks reduce risk, but cannot guarantee detection of every threat or zero-day vulnerability.';

function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function transferLabel(transfer: AttachmentTransfer): string {
  if (transfer.status === 'active') {
    if (transfer.cancelling) return 'Cancelling…';
    return {
      downloading: 'Downloading attachment',
      uploading: 'Uploading for scan',
      scanning: 'Scanning on server',
      saving: 'Saving to your computer',
    }[transfer.phase ?? 'downloading'];
  }
  return {
    ready: 'Ready to preview',
    saved: 'Saved to your computer',
    opened: 'Opened in your default app',
    failed: 'Attachment blocked or unavailable',
    cancelled: 'Cancelled',
  }[transfer.status];
}

function transferIcon(transfer: AttachmentTransfer) {
  if (transfer.notScanned || transfer.status === 'failed') return <ShieldAlert aria-hidden="true" />;
  if (transfer.status === 'active') {
    if (transfer.phase === 'uploading') return <ArrowUpToLine aria-hidden="true" />;
    if (transfer.phase === 'scanning') return <ShieldCheck aria-hidden="true" />;
    return <ArrowDownToLine aria-hidden="true" />;
  }
  if (transfer.status === 'cancelled') return <File aria-hidden="true" />;
  return <CheckCircle2 aria-hidden="true" />;
}

/** A notification surface, not a modal: mail remains readable during transfers. */
export function AttachmentTransferPopup(props: AttachmentTransferPopupProps) {
  const { transfers, onDismiss, onMinimize } = props;
  const [collapsed, setCollapsed] = useState(false);
  const previous = useRef(new Map(transfers.map((transfer) => [transfer.id, transfer.status])));

  useEffect(() => {
    const completed = transfers.some((transfer) => transfer.status !== 'active' &&
      previous.current.get(transfer.id) !== transfer.status);
    previous.current = new Map(transfers.map((transfer) => [transfer.id, transfer.status]));
    // A newly completed notification expands without moving keyboard focus or
    // reopening a preview the user has deliberately minimized.
    if (completed) setCollapsed(false);
  }, [transfers]);

  if (!transfers.length) return null;

  const active = transfers.filter((transfer) => transfer.status === 'active');
  const summary = active[0] ?? transfers[transfers.length - 1];

  return (
    <section className="attachment-transfers" aria-label="Attachment transfers" data-collapsed={collapsed}>
      <header className="attachment-transfers__header">
        <span className="attachment-transfers__header-icon" aria-hidden="true">
          {active.length ? <Loader2 className="attachment-transfers__spinner" /> : <ArrowDownToLine />}
        </span>
        <div className="attachment-transfers__heading">
          <h2>Attachments{active.length > 0 && <span className="attachment-transfers__count">{active.length}</span>}</h2>
          {collapsed && <p>{transferLabel(summary)}{transfers.length > 1 ? ` · ${transfers.length} files` : ''}</p>}
        </div>
        <Tooltip content={SECURITY_DETAILS} maxWidth={300} delayMs={40}>
          <button type="button" className="attachment-transfers__icon-button" aria-label={SECURITY_DETAILS} title="About attachment security">
            <Info aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip content={collapsed ? 'Expand attachment transfers' : 'Minimize attachment transfers'} delayMs={40}>
          <button
            type="button"
            className="attachment-transfers__icon-button"
            aria-label={collapsed ? 'Expand attachment transfers' : 'Minimize attachment transfers'}
            aria-expanded={!collapsed}
            onClick={() => {
              if (!collapsed) onMinimize();
              setCollapsed(!collapsed);
            }}
          >
            {collapsed ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </button>
        </Tooltip>
        {collapsed && <Tooltip content="Hide transfers; active downloads continue" delayMs={40}>
          <button type="button" className="attachment-transfers__icon-button" aria-label="Hide attachment transfers" onClick={() => transfers.forEach((transfer) => onDismiss(transfer.id))}>
            <X aria-hidden="true" />
          </button>
        </Tooltip>}
      </header>
      {!collapsed && <div className="attachment-transfers__list">
        {transfers.map((transfer) => <TransferRow key={transfer.id} transfer={transfer} {...props} />)}
      </div>}
      <span role="status" aria-live="polite" aria-atomic="true" className="attachment-transfers__sr-only">
        {summary.filename}: {transferLabel(summary)}
      </span>
    </section>
  );
}

function TransferRow({ transfer, onCancel, onDismiss, onPreview, onOpenFile, onShowFolder, onRetry }: AttachmentTransferPopupProps & { transfer: AttachmentTransfer }) {
  const active = transfer.status === 'active';
  const bytePhase = transfer.phase === 'downloading' || transfer.phase === 'uploading';
  const measured = active && bytePhase && typeof transfer.totalBytes === 'number' &&
    Number.isFinite(transfer.totalBytes) && transfer.totalBytes > 0 && typeof transfer.transferredBytes === 'number' &&
    Number.isFinite(transfer.transferredBytes) && transfer.transferredBytes >= 0;
  const transferred = measured ? Math.min(transfer.transferredBytes!, transfer.totalBytes!) : 0;
  const percent = measured ? Math.min(100, Math.floor(transferred / transfer.totalBytes! * 100)) : undefined;
  const stage = { downloading: 0, uploading: 1, scanning: 2, saving: 3 }[transfer.phase ?? 'downloading'];
  const saved = transfer.status === 'saved' && Boolean(transfer.savedFileId);

  return (
    <article className="attachment-transfer" data-status={transfer.status} data-unscanned={Boolean(transfer.notScanned)} aria-label={transfer.filename}>
      <div className="attachment-transfer__file-row">
        <span className="attachment-transfer__file-icon">{transferIcon(transfer)}</span>
        <div className="attachment-transfer__file">
          <h3 title={transfer.filename}>{transfer.filename}</h3>
          <p className="attachment-transfer__phase">{transferLabel(transfer)}</p>
        </div>
        <Tooltip content={active ? 'Hide notification; transfer continues' : 'Dismiss notification'} delayMs={40}>
          <button type="button" className="attachment-transfers__icon-button" aria-label={`Dismiss ${transfer.filename} notification`} onClick={() => onDismiss(transfer.id)}>
            <X aria-hidden="true" />
          </button>
        </Tooltip>
      </div>

      {active && <div className="attachment-transfer__progress-area">
        <ol className="attachment-transfer__stages" aria-label={`Progress stages for ${transfer.filename}`}>
          {['Download', 'Upload', 'Scan'].map((label, index) => <li key={label} data-state={index < stage ? 'complete' : index === stage ? 'current' : 'next'} aria-current={index === stage ? 'step' : undefined}>
            <span aria-hidden="true">{index < stage ? <Check /> : index + 1}</span>{label}
          </li>)}
        </ol>
        <div className="attachment-transfer__progress-row">
          <div
            role="progressbar"
            aria-label={`${transferLabel(transfer)}: ${transfer.filename}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={measured ? `${percent}% · ${byteLabel(transferred)} of ${byteLabel(transfer.totalBytes!)}` : transferLabel(transfer)}
            className="attachment-transfer__progress"
            data-indeterminate={!measured}
          >
            <span style={measured ? { width: `${percent}%` } : undefined} />
          </div>
          {measured && <span className="attachment-transfer__percent">{percent}%</span>}
        </div>
        <div className="attachment-transfer__progress-meta">
          <span>{measured ? `${byteLabel(transferred)} of ${byteLabel(transfer.totalBytes!)}` : transfer.phase === 'scanning' ? 'Checking before opening' : 'Working in the background'}</span>
          {transfer.canCancel && <button type="button" className="attachment-transfer__cancel" disabled={transfer.cancelling} onClick={() => onCancel(transfer.id)} aria-label={`Cancel transfer of ${transfer.filename}`}>{transfer.cancelling ? 'Cancelling…' : 'Cancel'}</button>}
        </div>
      </div>}

      {transfer.error && <p role="alert" className="attachment-transfer__error">{transfer.error}</p>}
      {transfer.notScanned && <p className="attachment-transfer__warning"><ShieldAlert aria-hidden="true" />Not scanned for viruses</p>}
      {transfer.status === 'saved' && transfer.filePath && <p className="attachment-transfer__path" title={transfer.filePath}>{transfer.filePath}</p>}
      {(saved || transfer.status === 'ready' || transfer.status === 'failed' || transfer.status === 'cancelled') && <div className="attachment-transfer__actions">
        {saved && transfer.canOpenSavedFile && <button type="button" className="attachment-transfer__primary" onClick={() => onOpenFile(transfer.id)}><ExternalLink aria-hidden="true" />Open file</button>}
        {saved && <button type="button" onClick={() => onShowFolder(transfer.id)}><FolderOpen aria-hidden="true" />Show in folder</button>}
        {transfer.status === 'ready' && <button type="button" className="attachment-transfer__primary" onClick={() => onPreview(transfer.id)}><ExternalLink aria-hidden="true" />Open preview</button>}
        {(transfer.status === 'failed' || transfer.status === 'cancelled') && <button type="button" onClick={() => onRetry(transfer.id)}><RotateCcw aria-hidden="true" />Try again</button>}
      </div>}
    </article>
  );
}
