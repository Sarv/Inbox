import { describe, it, expect } from 'vitest';
import type { IIMAPClient } from '../../../src/types/imap';
import { FakeImapServer } from '../../../src/test-support/fake-imap-server';

describe('FakeImapServer satisfies IIMAPClient', () => {
  it('models basic mailbox behaviour', async () => {
    const server = new FakeImapServer({ condstore: true, qresync: true });
    const client: IIMAPClient = server;
    server.addFolder('INBOX');
    const uid = server.addMessage('INBOX', { subject: 'hello' });
    await client.connect({} as any);
    const status = await client.selectFolder('INBOX');
    expect(status.exists).toBe(1);
    expect(await client.fetchAllFlags()).toEqual([{ uid, flags: [] }]);
    await client.addFlags([uid], ['\\Seen']);
    expect(server.flagsOf('INBOX', uid)).toEqual(['\\Seen']);
    server.addFolder('Trash');
    const map = await client.moveMessages([uid], 'Trash');
    expect(map?.get(uid)).toBe(1);
    expect(server.messageCount('INBOX')).toBe(0);
    expect(server.messageCount('Trash')).toBe(1);
    server.addMessage('INBOX', { subject: 'second' });
    server.expungeOnServer('INBOX', 2);
    const q = await client.selectFolderWithQresync!('INBOX', 1, 0);
    expect(q.vanishedUids).toContain(2);
    server.bumpUidValidity('INBOX');
    const q2 = await client.selectFolderWithQresync!('INBOX', 1, 0);
    expect(q2.vanishedUids).toEqual([]);
  });
});
