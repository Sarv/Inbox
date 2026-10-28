import type { AttachmentDownloadPhase } from '../../../electron/preload';

/** A host-authorized attachment operation retained outside the message view. */
export interface AttachmentTransfer {
  id: string;
  key: string;
  emailId: string;
  accountId?: string;
  filename: string;
  operation: 'save' | 'open' | 'preview';
  status: 'active' | 'ready' | 'saved' | 'opened' | 'failed' | 'cancelled';
  phase?: AttachmentDownloadPhase;
  transferredBytes?: number;
  totalBytes?: number;
  error?: string;
  notScanned?: boolean;
  cancelling?: boolean;
  canCancel?: boolean;
  filePath?: string;
  savedFileId?: string;
  canOpenSavedFile?: boolean;
  startedAt: number;
  updatedAt: number;
}
