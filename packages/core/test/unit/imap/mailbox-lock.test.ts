import { describe, it, expect } from 'vitest';

import { ImapFlowClient } from '../../../src/imap/imapflow-client';

/**
 * The folder-selection race, on the real client.
 *
 * `SELECT` is connection state, not a command argument: everything issued after
 * it is interpreted against whatever mailbox the socket last selected. The
 * shared primary connection has several writers — the realtime manager's IDLE
 * re-arm and poll timers re-select INBOX on a schedule, while a folder-scoped
 * flag reconcile, deletion sweep, drain or Gmail-label repair is running its own
 * select-then-fetch on the same socket. In production that produced a steady
 * drip of `Mailbox mismatch` warnings (16 in three minutes on one account): the
 * `ensureCurrentFolder` guard caught the corruption, but the price was that the
 * reconcile/sweep/drain simply did not run, so local mail quietly stopped
 * agreeing with the server.
 *
 * `withFolder` closes it by holding a per-connection mutex across select+work,
 * and by routing EVERY select through that same lock so a barging re-select
 * queues instead of landing mid-section.
 *
 * These reach into the instance because the thing under test IS the socket's
 * mailbox state; reproducing it over a real connection would need a server and
 * precise timing.
 */

interface FakeImapFlow {
  usable: boolean;
  mailbox: { path: string } | null;
  mailboxOpen: (path: string) => Promise<{ uidValidity: bigint; uidNext: number; exists: number }>;
  status: () => Promise<{ unseen: number }>;
  close: () => void;
}

/** Resolve after `n` microtask turns — long enough for an interleaving to show. */
const microticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

function connectedClient(): { client: ImapFlowClient; fake: FakeImapFlow; selects: string[] } {
  const selects: string[] = [];
  const fake: FakeImapFlow = {
    usable: true,
    mailbox: null,
    mailboxOpen: async (path: string) => {
      selects.push(path);
      // A SELECT is a real round-trip; make it take one so a racing caller has
      // somewhere to squeeze in if the lock is not doing its job.
      await microticks(2);
      fake.mailbox = { path };
      return { uidValidity: 1n, uidNext: 100, exists: 5 };
    },
    status: async () => ({ unseen: 0 }),
    close: () => { fake.usable = false; },
  };

  const client = new ImapFlowClient();
  const internals = client as unknown as { connectionState: string; client: FakeImapFlow };
  internals.connectionState = 'authenticated';
  internals.client = fake;
  return { client, fake, selects };
}

describe('ImapFlowClient.withFolder — the mailbox lock', () => {
  // THE regression. A section that selects a folder and then issues commands
  // against it must see that folder for its whole duration, even while another
  // caller on the same connection re-selects INBOX. Without the lock the
  // observed mailbox flips mid-section and the fetch reads the wrong mailbox.
  it('keeps the section\'s mailbox selected while a concurrent select barges in', async () => {
    const { client, fake } = connectedClient();
    const observed: string[] = [];

    const section = client.withFolder('[Gmail]/All Mail', async () => {
      // Stand in for a whole-mailbox enumeration: several awaits, each of which
      // is an opportunity for someone else's SELECT to land.
      for (let step = 0; step < 4; step++) {
        observed.push(fake.mailbox!.path);
        await microticks(2);
      }
    });
    // The realtime manager's opportunistic re-select, fired mid-section.
    const barge = client.selectFolder('INBOX');

    await Promise.all([section, barge]);

    expect(observed).toEqual([
      '[Gmail]/All Mail',
      '[Gmail]/All Mail',
      '[Gmail]/All Mail',
      '[Gmail]/All Mail',
    ]);
    // The barging select is not dropped — it runs, just afterwards.
    expect(fake.mailbox!.path).toBe('INBOX');
  });

  // The same guarantee in the other direction: a section queued behind an
  // in-flight select must not start until that select has finished, or it would
  // observe the other caller's mailbox on its first command.
  it('makes a section queued behind a select wait for it', async () => {
    const { client, fake } = connectedClient();

    const barge = client.selectFolder('INBOX');
    let seen = '';
    const section = client.withFolder('Trash', async () => {
      seen = fake.mailbox!.path;
    });

    await Promise.all([barge, section]);
    expect(seen).toBe('Trash');
  });

  // Two sections on the same connection are serialized, so neither sees the
  // other's mailbox. This is what lets a Trash drain and an All Mail reconcile
  // both run on the primary without either silently aborting.
  it('serializes two sections targeting different folders', async () => {
    const { client, fake } = connectedClient();
    const trashSaw: string[] = [];
    const allMailSaw: string[] = [];

    await Promise.all([
      client.withFolder('Trash', async () => {
        for (let step = 0; step < 3; step++) {
          trashSaw.push(fake.mailbox!.path);
          await microticks(2);
        }
      }),
      client.withFolder('[Gmail]/All Mail', async () => {
        for (let step = 0; step < 3; step++) {
          allMailSaw.push(fake.mailbox!.path);
          await microticks(2);
        }
      }),
    ]);

    expect(new Set(trashSaw)).toEqual(new Set(['Trash']));
    expect(new Set(allMailSaw)).toEqual(new Set(['[Gmail]/All Mail']));
  });

  // Reentrancy. Nested helpers re-assert their folder as a matter of course
  // (`ensureFolderSelected` is called all over the sync paths). Without the
  // AsyncLocalStorage flag that inner call would queue behind the section that
  // is already holding the lock and the connection would deadlock — a hang, not
  // an error, which is the worst possible failure mode here.
  it('lets a section re-select and nest without deadlocking', async () => {
    const { client } = connectedClient();

    const result = await client.withFolder('Trash', async () => {
      await client.selectFolder('Trash');
      await client.ensureFolderSelected('Trash');
      return client.withFolder('Trash', async () => 'nested ok');
    });

    expect(result).toBe('nested ok');
  });

  // A nested section may legitimately target a DIFFERENT folder (a repair that
  // dips into All Mail). It must be allowed, and the lock must survive it.
  it('allows a nested section on another folder and stays usable afterwards', async () => {
    const { client, fake } = connectedClient();

    await client.withFolder('INBOX', async () => {
      await client.withFolder('[Gmail]/All Mail', async () => {
        expect(fake.mailbox!.path).toBe('[Gmail]/All Mail');
      });
    });

    await expect(client.withFolder('Trash', async () => fake.mailbox!.path)).resolves.toBe('Trash');
  });

  // `select: false` is for a section that issues its own specialised SELECT
  // (the QRESYNC resynchronising select, whose VANISHED response is the point).
  // It must take the lock WITHOUT spending a redundant SELECT round-trip.
  it('takes the lock without selecting when select is false', async () => {
    const { client, selects } = connectedClient();

    await client.withFolder('INBOX', async () => undefined, { select: false });

    expect(selects).toEqual([]);
  });

  it('still excludes a concurrent select when select is false', async () => {
    const { client, fake } = connectedClient();
    await client.selectFolder('INBOX');

    const observed: string[] = [];
    const section = client.withFolder('INBOX', async () => {
      for (let step = 0; step < 3; step++) {
        observed.push(fake.mailbox!.path);
        await microticks(2);
      }
    }, { select: false });
    const barge = client.selectFolder('Trash');

    await Promise.all([section, barge]);
    expect(new Set(observed)).toEqual(new Set(['INBOX']));
  });

  // Transient failure: a section that throws (connection blip, timeout) must
  // release the lock. If it didn't, one failed reconcile would wedge every
  // later mailbox operation on that connection for the rest of the session.
  it('releases the lock when the section throws', async () => {
    const { client, fake } = connectedClient();

    await expect(
      client.withFolder('Trash', async () => {
        throw new Error('connection blip');
      }),
    ).rejects.toThrow('connection blip');

    await expect(client.withFolder('INBOX', async () => fake.mailbox!.path)).resolves.toBe('INBOX');
  });

  // A failing SELECT is a permanent-looking error for that section only; the
  // next section must still be able to select a folder that does exist.
  it('releases the lock when the SELECT itself fails', async () => {
    const { client, fake } = connectedClient();
    fake.mailboxOpen = async (path: string) => {
      if (path === 'Nope') throw new Error('NONEXISTENT');
      fake.mailbox = { path };
      return { uidValidity: 1n, uidNext: 100, exists: 5 };
    };

    await expect(client.withFolder('Nope', async () => 'unreachable')).rejects.toThrow();
    await expect(client.withFolder('INBOX', async () => fake.mailbox!.path)).resolves.toBe('INBOX');
  });

  // Idempotent re-run: the same section run twice behaves identically — sync
  // passes re-enter these constantly.
  it('behaves the same on a repeated run', async () => {
    const { client, fake } = connectedClient();
    const run = () => client.withFolder('Trash', async () => fake.mailbox!.path);

    await expect(run()).resolves.toBe('Trash');
    await expect(run()).resolves.toBe('Trash');
  });

  // Multi-account: each account has its own connection and therefore its own
  // lock. One account's long section must never block another's — accounts
  // sync in parallel and a shared lock would serialize the whole app.
  it('does not block a second connection', async () => {
    const first = connectedClient();
    const second = connectedClient();
    let secondRan = false;
    let releaseFirst = (): void => {};
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const firstSection = first.client.withFolder('INBOX', async () => { await gate; });
    await second.client.withFolder('INBOX', async () => { secondRan = true; });

    expect(secondRan).toBe(true);
    releaseFirst();
    await firstSection;
  });

  it('refuses to run a section on a disconnected client', async () => {
    const client = new ImapFlowClient();
    await expect(client.withFolder('INBOX', async () => 'nope')).rejects.toThrow(/not connected/i);
  });
});
