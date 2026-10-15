/** Host-generated evidence only: callers identify an owned message and declared filename. */
export interface AssistantAttachmentRef {
  accountId: string;
  emailId: string;
  filename: string;
}

export type AssistantAttachmentStatus =
  | 'ready'
  | 'empty'
  | 'scanned'
  | 'password_protected'
  | 'unsupported'
  | 'too_large'
  | 'malformed'
  | 'blocked'
  | 'missing'
  | 'cancelled'
  | 'timeout'
  | 'unavailable';

export interface AssistantAttachmentLocator {
  kind: 'page' | 'paragraph' | 'sheet' | 'slide' | 'line';
  label: string;
  page?: number;
  paragraph?: number;
  sheet?: string;
  cellRange?: string;
  slide?: number;
  rowStart?: number;
  rowEnd?: number;
  lineStart?: number;
  lineEnd?: number;
}

export interface AssistantAttachmentSegment {
  text: string;
  locator: AssistantAttachmentLocator;
}

export interface AssistantAttachmentExtraction {
  status: AssistantAttachmentStatus;
  segments: AssistantAttachmentSegment[];
  truncated: boolean;
  /** Safe, fixed explanation for coverage; never a parser stack trace or local path. */
  message?: string;
}

export interface AssistantAttachmentResult extends AssistantAttachmentExtraction {
  ref: AssistantAttachmentRef;
}

export const ASSISTANT_ATTACHMENT_LIMITS = {
  bytes: 10 * 1024 * 1024,
  characters: 120_000,
  segmentCharacters: 3_000,
  segments: 400,
  pages: 100,
  sheets: 40,
  rows: 5_000,
  zipEntries: 2_000,
  xmlEntryBytes: 6 * 1024 * 1024,
  uncompressedBytes: 24 * 1024 * 1024,
  timeoutMs: 15_000,
} as const;

export function assistantAttachmentFailure(
  status: AssistantAttachmentStatus,
  message?: string,
): AssistantAttachmentExtraction {
  return { status, segments: [], truncated: false, ...(message ? { message } : {}) };
}
