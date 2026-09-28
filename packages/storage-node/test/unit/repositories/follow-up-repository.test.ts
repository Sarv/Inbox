import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FollowUpRepository } from '../../../src/repositories/follow-up-repository';
import { newMigratedDb } from '../../../src/test-support/test-db';

// Follow-up reminders fail quietly: a reply that isn't recognised nags the user
// about a conversation that already answered, a reply that's wrongly seen
// cancels the one reminder they asked for, and a retried send that adds a
// second row notifies twice. Every test below names which of those it guards.

const FROZEN_MS = Date.parse('2026-09-28T09:00:00.000Z');
const NOW = Math.floor(FROZEN_MS / 1000);
const DAY = 86_400;
const ME = 'me@example.com';
const SENT_MID = '<sent-1@example.com>';

interface EmailSeed {
  id: string;
  messageId: string;
  threadId: string;
  folderId?: string;
  from?: string;
  date?: number;
  inReplyTo?: string | null;
}

function insertEmail(db: Database.Database, seed: EmailSeed): void {
  db.prepare(
    `INSERT OR IGNORE INTO threads (id, subject, first_message_id, last_message_id, last_message_date)
     VALUES (?, 'thread', ?, ?, 0)`,
  ).run(seed.threadId, seed.messageId, seed.messageId);
  db.prepare(
    `INSERT INTO emails (
       id, message_id, thread_id, folder_id, uid, tags, subject, from_address, date,
       clean_body, raw_body, content_type, content_hash, in_reply_to
     ) VALUES (?, ?, ?, ?, 1, '||', 'subject', ?, ?, 'body', 'raw', 'text', ?, ?)`,
  ).run(
    seed.id,
    seed.messageId,
    seed.threadId,
    seed.folderId ?? 'f-inbox',
    seed.from ?? 'alice@example.com',
    seed.date ?? NOW,
    `hash-${seed.id}`,
    seed.inReplyTo ?? null,
  );
}

describe('FollowUpRepository', () => {
  let db: Database.Database;
  let repo: FollowUpRepository;

  const createDefault = (over: Partial<Parameters<FollowUpRepository['create']>[0]> = {}) =>
    repo.create({
      messageId: SENT_MID,
      subject: 'Quote for the roof',
      recipients: 'Alice <alice@example.com>',
      fromAddress: 'Me@Example.com',
      sentAt: NOW,
      dueAt: NOW + 3 * DAY,
      ...over,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_MS);
    db = newMigratedDb();
    repo = new FollowUpRepository(() => db);
    const folder = db.prepare('INSERT INTO folders (id, name, path, special_use) VALUES (?, ?, ?, ?)');
    folder.run('f-inbox', 'INBOX', 'INBOX', '\\Inbox');
    folder.run('f-sent', 'Sent', 'Sent', '\\Sent');
    folder.run('f-drafts', 'Drafts', 'Drafts', '\\Drafts');
    insertEmail(db, { id: 'sent-1', messageId: SENT_MID, threadId: 't1', folderId: 'f-sent', from: ME });
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  describe('create', () => {
    // The reminder must come back exactly as asked, linked to the sent message's
    // thread so the notification can open it.
    it('stores a pending reminder linked to the sent message and its thread', () => {
      const followUp = createDefault();
      expect(followUp).toEqual({
        id: followUp.id,
        messageId: SENT_MID,
        subject: 'Quote for the roof',
        recipients: 'Alice <alice@example.com>',
        fromAddress: ME,
        sentAt: NOW,
        dueAt: NOW + 3 * DAY,
        status: 'pending',
        resolvedAt: null,
        emailId: 'sent-1',
        threadId: 't1',
      });
    });

    // Outbox retries send the same Message-ID again; a second row would notify twice.
    it('is idempotent on the Message-ID and keeps the existing state', () => {
      const first = createDefault();
      repo.setStatus(first.id, 'dismissed');
      const again = createDefault({ dueAt: NOW + DAY });
      expect(again.id).toBe(first.id);
      expect(again.status).toBe('dismissed');
      expect(again.dueAt).toBe(NOW + 3 * DAY);
      expect(db.prepare('SELECT COUNT(*) AS n FROM follow_ups').get()).toEqual({ n: 1 });
    });

    // A reminder may exist before its sent copy is in the DB (no Sent folder yet).
    it('works with no local copy of the sent message and fills the defaults', () => {
      const followUp = repo.create({ messageId: '<other@x>', sentAt: NOW, dueAt: NOW + DAY });
      expect(followUp).toMatchObject({ subject: '', recipients: '', fromAddress: '', emailId: null, threadId: null });
    });
  });

  describe('listOpen / get', () => {
    // Due reminders are the ones needing action, so they lead; ended ones never show.
    it('lists due first, then soonest pending, and hides ended reminders', () => {
      const later = createDefault({ messageId: '<a@x>', dueAt: NOW + 5 * DAY });
      const sooner = createDefault({ messageId: '<b@x>', dueAt: NOW + DAY });
      const due = createDefault({ messageId: '<c@x>', dueAt: NOW + 9 * DAY });
      const replied = createDefault({ messageId: '<d@x>' });
      repo.setStatus(due.id, 'due');
      repo.setStatus(replied.id, 'replied');

      expect(repo.listOpen().map((f) => f.id)).toEqual([due.id, sooner.id, later.id]);
      expect(repo.listOpen(1).map((f) => f.id)).toEqual([due.id]);
    });

    it('looks a reminder up by id', () => {
      const followUp = createDefault();
      expect(repo.get(followUp.id)?.messageId).toBe(SENT_MID);
      expect(repo.get('missing')).toBeNull();
    });
  });

  describe('hasReply', () => {
    const followUp = { messageId: SENT_MID, fromAddress: ME, sentAt: NOW };

    // No reply yet: the reminder must stay live.
    it('is false when only our own message is in the thread', () => {
      expect(repo.hasReply(followUp)).toBe(false);
    });

    // The recipient answered in-thread after we sent.
    it('sees a later message in the same thread from someone else', () => {
      insertEmail(db, { id: 'r1', messageId: '<r1@x>', threadId: 't1', date: NOW + 60 });
      expect(repo.hasReply(followUp)).toBe(true);
    });

    // In-Reply-To is definitive even when the replier's clock is behind ours.
    it('sees a direct reply by In-Reply-To whatever its date', () => {
      insertEmail(db, { id: 'r1', messageId: '<r1@x>', threadId: 'elsewhere', date: NOW - 600, inReplyTo: SENT_MID });
      expect(repo.hasReply(followUp)).toBe(true);
    });

    // Earlier mail in the thread is what we were replying to, not an answer.
    it('ignores thread messages dated before we sent', () => {
      insertEmail(db, { id: 'old', messageId: '<old@x>', threadId: 't1', date: NOW - DAY });
      expect(repo.hasReply(followUp)).toBe(false);
    });

    // Our own follow-up nudge must not cancel our own reminder — by address,
    // case-insensitively, or (for an alias) by being in Sent / Drafts.
    it('never counts our own mail as a reply', () => {
      insertEmail(db, { id: 'mine', messageId: '<mine@x>', threadId: 't1', date: NOW + 60, from: 'ME@example.com' });
      insertEmail(db, { id: 'alias', messageId: '<alias@x>', threadId: 't1', date: NOW + 60, from: 'alias@example.com', folderId: 'f-sent' });
      insertEmail(db, { id: 'draft', messageId: '<draft@x>', threadId: 't1', date: NOW + 60, from: 'alias@example.com', folderId: 'f-drafts', inReplyTo: SENT_MID });
      expect(repo.hasReply(followUp)).toBe(false);
    });
  });

  describe('setStatus', () => {
    // Ending a reminder stamps when; flagging it due does not.
    it('moves an open reminder and stamps resolved_at only when it ends', () => {
      const followUp = createDefault();
      expect(repo.setStatus(followUp.id, 'due')).toBe(true);
      expect(repo.get(followUp.id)).toMatchObject({ status: 'due', resolvedAt: null });
      expect(repo.setStatus(followUp.id, 'replied')).toBe(true);
      expect(repo.get(followUp.id)).toMatchObject({ status: 'replied', resolvedAt: NOW });
    });

    // A dismissed reminder must never be revived by a late checker pass.
    it('refuses to change a reminder that already ended', () => {
      const followUp = createDefault();
      repo.setStatus(followUp.id, 'dismissed');
      expect(repo.setStatus(followUp.id, 'due')).toBe(false);
      expect(repo.get(followUp.id)?.status).toBe('dismissed');
      expect(repo.setStatus('missing', 'due')).toBe(false);
    });
  });
});
