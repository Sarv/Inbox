import type { EmailRecord } from '@sarvinbox/core';

/**
 * Shared fixtures for tests that need real-shaped mail.
 *
 * An EmailRecord has ~35 columns and almost every test cares about three of
 * them. Building one here rather than per file keeps a schema change to one
 * edit, and stops two suites disagreeing about what an "ordinary" message is.
 */

/** An EmailRecord with only the fields a test cares about. */
export const emailRecord = (over: Partial<EmailRecord> & Record<string, unknown> = {}): EmailRecord =>
  ({
    id: 'e1',
    messageId: '<m1@x>',
    threadId: 't1',
    folderId: 'INBOX',
    uid: 1,
    tags: '|INBOX|',
    subject: 'Subject',
    fromAddress: 'sender@x.com',
    fromName: 'Sender',
    toAddress: 'advik.d@sarv.com',
    toNames: null,
    ccAddress: null,
    ccNames: null,
    bccAddress: null,
    bccNames: null,
    replyTo: null,
    date: 1_000,
    receivedDate: null,
    cleanBody: '',
    rawBody: '',
    contentType: 'html',
    contentHash: 'h',
    inReplyTo: null,
    references: null,
    priority: null,
    hasAttachments: false,
    attachmentCount: 0,
    attachmentNames: null,
    attachmentSizes: null,
    hasEmbedding: false,
    embeddingLastGenerated: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as EmailRecord;
