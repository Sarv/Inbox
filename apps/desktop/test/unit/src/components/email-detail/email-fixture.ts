// One stored email, with only the columns a test cares about spelled out.
//
// Shared because more than one suite here converts EmailRecords: a second copy
// of this builder drifts, and a test that passes against a row shape the app
// never sees protects nothing.
import type { EmailRecord } from '@sarvinbox/core';

/** Seconds, the unit sarvinbox stores — deliberately not milliseconds. */
export const TEN_AM = 1772532000; // 2026-03-03T10:00:00Z
export const ELEVEN_AM = TEN_AM + 3600;

export const ME = 'me@acme.example';

export function email(overrides: Partial<EmailRecord> & { id: string }): EmailRecord {
  return {
    messageId: `<${overrides.id}@acme.example>`,
    threadId: 't1',
    folderId: 'INBOX',
    uid: 1,
    tags: '',
    subject: 'Q3',
    fromAddress: 'alice@acme.example',
    fromName: 'Alice Chen',
    toAddress: ME,
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: TEN_AM,
    receivedDate: null,
    cleanBody: '',
    rawBody: '',
    contentType: 'html',
    contentHash: 'hash',
    inReplyTo: null,
    references: null,
    priority: null,
    hasAttachments: false,
    attachmentCount: 0,
    attachmentNames: null,
    attachmentSizes: null,
    hasEmbedding: false,
    embeddingLastGenerated: null,
    ...overrides,
  } as EmailRecord;
}
