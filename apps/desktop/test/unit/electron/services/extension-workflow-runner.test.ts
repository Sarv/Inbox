import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

/**
 * Extension workflow runner. Pinned behaviour:
 *   - `email:synced` runs the workflows for NEW mail only, at the 'arrival'
 *     stage; `email:body-ready` re-runs them at the 'body' stage,
 *   - with nothing installed the whole service does no I/O at all,
 *   - a permitted label is persisted and a permitted flag is carried to the
 *     server; an unpermitted one is refused and logged once,
 *   - work is serialised through one queue with a bounded size, so a first sync
 *     cannot start thousands of concurrent workflow runs,
 *   - one message's failure never stops the queue,
 *   - stop() unsubscribes and drops anything still queued.
 */

const h = vi.hoisted(() => ({
  logs: [] as string[],
  busHandlers: new Map<string, Array<(event: unknown) => void>>(),
  unsubCalls: [] as string[],
  manager: null as any,
  storageByEmail: new Map<string, any>(),
  syncEngine: null as any,
  yields: 0,
}));

// The real planner, imported from core SRC: it is pure, and it is the whole
// permission boundary — stubbing it would leave the runner's enforcement untested.
vi.mock('@sarvinbox/core', async () => {
  const effects = await import(
    '../../../../../../packages/core/src/extensions/workflow-effects'
  );
  return {
    planWorkflowEffects: effects.planWorkflowEffects,
    createLogger: () => ({
      info: (...args: unknown[]) => h.logs.push(args.join(' ')),
      warn: (...args: unknown[]) => h.logs.push(args.join(' ')),
      error: (...args: unknown[]) => h.logs.push(args.join(' ')),
      debug: () => {},
    }),
    createLoopYielder: () => async () => {
      h.yields += 1;
      return false;
    },
    getEventBus: () => ({
      on: (event: string, handler: (payload: unknown) => void) => {
        const handlers = h.busHandlers.get(event) ?? [];
        handlers.push(handler);
        h.busHandlers.set(event, handlers);
        return () => h.unsubCalls.push(event);
      },
    }),
  };
});

vi.mock('../../../../electron/shared', () => ({
  getExtensionManager: () => h.manager,
  findStorageForEmail: (emailId: string) => h.storageByEmail.get(emailId) ?? null,
  getSyncEngineForStorage: () => h.syncEngine,
  getAccountIdForStorage: () => 'account-1',
}));

import {
  MAX_PENDING,
  startExtensionWorkflowRunner,
  stopExtensionWorkflowRunner,
} from '../../../../electron/services/extension-workflow-runner';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeStorage {
  getEmail: (id: string) => Promise<any>;
  updateEmail: Mock;
  getFolder: (id: string) => Promise<any>;
}

function makeStorage(emails: Record<string, any>): FakeStorage {
  return {
    getEmail: async (id: string) => emails[id] ?? null,
    updateEmail: vi.fn(async () => {}),
    getFolder: async () => ({ id: 'inbox', path: 'INBOX' }),
  };
}

function makeEmail(id: string, overrides: Record<string, unknown> = {}) {
  return { id, accountId: 'account-1', folderId: 'inbox', uid: 42, tags: '||', ...overrides };
}

interface WorkflowSpec {
  workflowId: string;
  extensionId: string;
  permissions: string[];
  /** What processEmail returns for this workflow, per stage. */
  result: (stage: string, email: any) => any;
}

function installManager(specs: WorkflowSpec[], processEmail?: (...args: any[]) => Promise<any>) {
  const calls: Array<{ emailId: string; stage: string }> = [];
  h.manager = {
    getActiveWorkflowIds: () => specs.map((spec) => spec.workflowId),
    getHost: () => ({
      getAllWorkflowAdapters: () =>
        specs.map((spec) => ({ id: spec.workflowId, extensionId: spec.extensionId })),
    }),
    getExtensionInfo: (extensionId: string) => {
      const spec = specs.find((candidate) => candidate.extensionId === extensionId);
      return spec ? { manifest: { permissions: spec.permissions } } : null;
    },
    processEmail:
      processEmail ??
      (async (email: any, _a: unknown, _b: unknown, stage: string) => {
        calls.push({ emailId: email.id, stage });
        const results = new Map<string, any>();
        for (const spec of specs) {
          const result = spec.result(stage, email);
          if (result) results.set(spec.workflowId, result);
        }
        return results;
      }),
  };
  return calls;
}

function emitSynced(email: any, isNew = true): void {
  for (const handler of h.busHandlers.get('email:synced') ?? []) handler({ email, isNew });
}

function emitBodyReady(emailId: string): void {
  for (const handler of h.busHandlers.get('email:body-ready') ?? []) handler({ emailId });
}

/** Let the serial drain finish; it is kicked off with `void drain()`. */
async function settle(): Promise<void> {
  // Macrotask turns, not just microtasks: a workflow run may await real I/O, and
  // the drain is serial, so each queued message needs its own turn of the loop.
  for (let turn = 0; turn < 30; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const labelResult = (label: string) => () => ({ success: true, labelsToAdd: [label] });

beforeEach(() => {
  h.logs.length = 0;
  h.busHandlers.clear();
  h.unsubCalls.length = 0;
  h.manager = null;
  h.storageByEmail.clear();
  h.syncEngine = null;
  h.yields = 0;
});

afterEach(() => {
  stopExtensionWorkflowRunner();
});

// ---------------------------------------------------------------------------

describe('startExtensionWorkflowRunner - subscriptions', () => {
  it('runs workflows at the arrival stage for new mail', () => {
    // Regression: nothing calls processEmail, so every workflow an extension
    // registers is dead code — exactly the bug this service exists to fix.
    const calls = installManager([
      { workflowId: 'w1', extensionId: 'ext', permissions: ['email:label'], result: labelResult('vip') },
    ]);
    h.storageByEmail.set('e1', makeStorage({ e1: makeEmail('e1') }));

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));

    return settle().then(() => {
      expect(calls).toEqual([{ emailId: 'e1', stage: 'arrival' }]);
    });
  });

  it('ignores a re-sync of mail that already existed', async () => {
    // Regression: every reconnect re-runs every workflow over the whole mailbox,
    // which for an AI workflow is a bill and a stalled main process.
    const calls = installManager([
      { workflowId: 'w1', extensionId: 'ext', permissions: ['email:label'], result: labelResult('vip') },
    ]);
    h.storageByEmail.set('e1', makeStorage({ e1: makeEmail('e1') }));

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'), false);
    await settle();

    expect(calls).toHaveLength(0);
  });

  it('runs a second pass at the body stage once a body arrives', async () => {
    // Regression: bodies are fetched AFTER email:synced, so a requiresBody
    // workflow never sees one and every body-dependent extension does nothing.
    const calls = installManager([
      { workflowId: 'w1', extensionId: 'ext', permissions: ['email:label'], result: labelResult('vip') },
    ]);
    h.storageByEmail.set('e1', makeStorage({ e1: makeEmail('e1') }));

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    emitBodyReady('e1');
    await settle();

    expect(calls).toEqual([
      { emailId: 'e1', stage: 'arrival' },
      { emailId: 'e1', stage: 'body' },
    ]);
  });

  it('drops events with no email id', async () => {
    // Regression: a malformed event throws inside a fire-and-forget bus handler,
    // where nothing catches it.
    installManager([
      { workflowId: 'w1', extensionId: 'ext', permissions: ['email:label'], result: labelResult('vip') },
    ]);

    startExtensionWorkflowRunner();
    for (const handler of h.busHandlers.get('email:synced') ?? []) {
      handler({ isNew: true });
      handler(undefined);
    }
    for (const handler of h.busHandlers.get('email:body-ready') ?? []) handler({});
    await settle();

    expect(h.logs.filter((line) => line.includes('failed'))).toHaveLength(0);
  });

  it('subscribes only once however often it is started', async () => {
    // Regression: a second start doubles every workflow run for the rest of the
    // session.
    const calls = installManager([
      { workflowId: 'w1', extensionId: 'ext', permissions: ['email:label'], result: labelResult('vip') },
    ]);
    h.storageByEmail.set('e1', makeStorage({ e1: makeEmail('e1') }));

    startExtensionWorkflowRunner();
    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    await settle();

    expect(calls).toHaveLength(1);
  });
});

describe('startExtensionWorkflowRunner - no extensions installed', () => {
  it('does no work when there is no manager', async () => {
    // Regression: the runner reads the database for every message that arrives
    // even on an install with no extensions at all.
    const storage = makeStorage({ e1: makeEmail('e1') });
    h.storageByEmail.set('e1', storage);
    h.manager = null;

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    await settle();

    expect(storage.updateEmail).not.toHaveBeenCalled();
  });

  it('does no work when no extension contributes a workflow', async () => {
    // Regression: same cost, paid by anyone whose extensions are all UI-only.
    const processEmail = vi.fn(async () => new Map());
    installManager([], processEmail);
    h.storageByEmail.set('e1', makeStorage({ e1: makeEmail('e1') }));

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    await settle();

    expect(processEmail).not.toHaveBeenCalled();
  });
});

describe('startExtensionWorkflowRunner - applying results', () => {
  it('persists a label the extension is permitted to add', async () => {
    // Regression: workflows run and their output is thrown away, so an
    // extension appears installed and working while changing nothing.
    installManager([
      { workflowId: 'w1', extensionId: 'vip', permissions: ['email:label'], result: labelResult('vip') },
    ]);
    const storage = makeStorage({ e1: makeEmail('e1') });
    h.storageByEmail.set('e1', storage);

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    await settle();

    expect(storage.updateEmail).toHaveBeenCalledWith('e1', { tags: '|vip|' });
  });

  it('refuses a label from an extension without email:label, and logs it once', async () => {
    // Regression: an extension installed to READ mail can label it just by
    // returning a field — the manifest permission becomes documentation.
    installManager([
      { workflowId: 'w1', extensionId: 'nosy', permissions: ['email:read'], result: labelResult('vip') },
    ]);
    const storage = makeStorage({ e1: makeEmail('e1'), e2: makeEmail('e2') });
    h.storageByEmail.set('e1', storage);
    h.storageByEmail.set('e2', storage);

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    emitSynced(makeEmail('e2'));
    await settle();

    expect(storage.updateEmail).not.toHaveBeenCalled();
    expect(h.logs.filter((line) => line.includes("Refused 'vip'"))).toHaveLength(1);
  });

  it('carries a permitted flag to the server on the folder path', async () => {
    // Regression: the star shows locally and is gone after the next sync,
    // because it was never written to IMAP.
    installManager([
      {
        workflowId: 'w1',
        extensionId: 'vip',
        permissions: ['email:flag'],
        result: () => ({ success: true, labelsToAdd: ['starred'] }),
      },
    ]);
    const storage = makeStorage({ e1: makeEmail('e1') });
    h.storageByEmail.set('e1', storage);
    h.syncEngine = { markAsStarred: vi.fn(async () => {}), markAsRead: vi.fn(async () => {}) };

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    await settle();

    expect(storage.updateEmail).toHaveBeenCalledWith('e1', { tags: '|starred|' });
    expect(h.syncEngine.markAsStarred).toHaveBeenCalledWith('INBOX', 42, true);
    expect(h.syncEngine.markAsRead).not.toHaveBeenCalled();
  });

  it('keeps going when the server rejects a flag', async () => {
    // Regression: a transient IMAP failure abandons the rest of the queue, so
    // one offline moment costs every message behind it.
    installManager([
      {
        workflowId: 'w1',
        extensionId: 'vip',
        permissions: ['email:flag'],
        result: () => ({ success: true, labelsToAdd: ['starred'] }),
      },
    ]);
    const storage = makeStorage({ e1: makeEmail('e1'), e2: makeEmail('e2') });
    h.storageByEmail.set('e1', storage);
    h.storageByEmail.set('e2', storage);
    h.syncEngine = {
      markAsStarred: vi.fn(async () => {
        throw new Error('connection reset');
      }),
      markAsRead: vi.fn(async () => {}),
    };

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    emitSynced(makeEmail('e2'));
    await settle();

    expect(h.syncEngine.markAsStarred).toHaveBeenCalledTimes(2);
    expect(storage.updateEmail).toHaveBeenCalledTimes(2);
  });

  it('skips a result whose workflow no longer maps to an extension', async () => {
    // Regression: an extension deactivated mid-run leaves a result with no
    // permissions to check, and it gets applied unchecked.
    const processEmail = vi.fn(async () => new Map([['ghost', { success: true, labelsToAdd: ['vip'] }]]));
    installManager(
      [{ workflowId: 'w1', extensionId: 'vip', permissions: ['email:label'], result: labelResult('vip') }],
      processEmail
    );
    const storage = makeStorage({ e1: makeEmail('e1') });
    h.storageByEmail.set('e1', storage);

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    await settle();

    expect(storage.updateEmail).not.toHaveBeenCalled();
  });

  it('writes nothing when no workflow asked for a change', async () => {
    // Regression: every message is re-written on every pass, turning a read-only
    // extension into a full-mailbox write on each sync.
    installManager([
      { workflowId: 'w1', extensionId: 'reader', permissions: ['email:read'], result: () => ({ success: true }) },
    ]);
    const storage = makeStorage({ e1: makeEmail('e1') });
    h.storageByEmail.set('e1', storage);

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    await settle();

    expect(storage.updateEmail).not.toHaveBeenCalled();
  });
});

describe('startExtensionWorkflowRunner - resilience', () => {
  it('does nothing for an id no database holds', async () => {
    // Regression: the id can reach the bus before the insert lands; a throw here
    // is unhandled inside a fire-and-forget emit.
    const calls = installManager([
      { workflowId: 'w1', extensionId: 'vip', permissions: ['email:label'], result: labelResult('vip') },
    ]);

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('missing'));
    await settle();

    expect(calls).toHaveLength(0);
    expect(h.logs.filter((line) => line.includes('failed'))).toHaveLength(0);
  });

  it('does nothing when the row is gone from the storage that claimed it', async () => {
    // Regression: a message deleted between the event and the drain throws on a
    // null email.
    installManager([
      { workflowId: 'w1', extensionId: 'vip', permissions: ['email:label'], result: labelResult('vip') },
    ]);
    const storage = makeStorage({});
    h.storageByEmail.set('e1', storage);

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    await settle();

    expect(storage.updateEmail).not.toHaveBeenCalled();
  });

  it('logs a failing message and carries on with the queue', async () => {
    // Regression: one extension that throws stops every later message from
    // being processed for the rest of the session.
    let attempt = 0;
    const seen: string[] = [];
    const processEmail = vi.fn(async (email: any) => {
      attempt += 1;
      seen.push(email.id);
      if (attempt === 1) throw new Error('extension blew up');
      return new Map([['w1', { success: true, labelsToAdd: ['vip'] }]]);
    });
    installManager(
      [{ workflowId: 'w1', extensionId: 'vip', permissions: ['email:label'], result: labelResult('vip') }],
      processEmail
    );
    const storage = makeStorage({ e1: makeEmail('e1'), e2: makeEmail('e2') });
    h.storageByEmail.set('e1', storage);
    h.storageByEmail.set('e2', storage);

    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    emitSynced(makeEmail('e2'));
    await settle();

    expect(seen).toEqual(['e1', 'e2']);
    expect(storage.updateEmail).toHaveBeenCalledWith('e2', { tags: '|vip|' });
    expect(h.logs.some((line) => line.includes('Extension workflows failed for e1'))).toBe(true);
  });

  it('runs one message at a time and yields between them', async () => {
    // Regression: a first sync starts a workflow run per message at once —
    // thousands of concurrent AI calls and database reads on the main process.
    let inFlight = 0;
    let maxInFlight = 0;
    const processEmail = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return new Map();
    });
    installManager(
      [{ workflowId: 'w1', extensionId: 'vip', permissions: ['email:label'], result: labelResult('vip') }],
      processEmail
    );
    const storage = makeStorage(
      Object.fromEntries(['e1', 'e2', 'e3', 'e4'].map((id) => [id, makeEmail(id)]))
    );
    for (const id of ['e1', 'e2', 'e3', 'e4']) h.storageByEmail.set(id, storage);

    startExtensionWorkflowRunner();
    for (const id of ['e1', 'e2', 'e3', 'e4']) emitSynced(makeEmail(id));
    await settle();

    expect(processEmail).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBe(1);
    expect(h.yields).toBeGreaterThanOrEqual(4);
  });

  it('caps the queue and drops the oldest entries with one summary warning', async () => {
    // Regression: a 40,000-message first sync pins the ids of a whole mailbox in
    // memory for work that is enrichment, not correctness.
    const seen: string[] = [];
    const processEmail = vi.fn(async (email: any) => {
      seen.push(email.id);
      return new Map();
    });
    installManager(
      [{ workflowId: 'w1', extensionId: 'vip', permissions: ['email:label'], result: labelResult('vip') }],
      processEmail
    );

    // Block the drain until everything has been enqueued, so the cap is what
    // decides which messages survive rather than the drain keeping up.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage = makeStorage({});
    storage.getEmail = async (id: string) => {
      await gate;
      return makeEmail(id);
    };
    const overflow = MAX_PENDING + 5;
    for (let index = 0; index < overflow; index += 1) h.storageByEmail.set(`e${index}`, storage);

    startExtensionWorkflowRunner();
    for (let index = 0; index < overflow; index += 1) emitSynced(makeEmail(`e${index}`));
    release();
    await settle();

    // The first entry is already being drained; the rest of the dropped ones are
    // the oldest still waiting, and the newest arrivals all survive.
    expect(seen).toContain(`e${overflow - 1}`);
    expect(seen).not.toContain('e3');
    expect(h.logs.some((line) => line.includes('more than 2000 were waiting'))).toBe(true);
  });
});

describe('stopExtensionWorkflowRunner', () => {
  it('unsubscribes from both events', async () => {
    // Regression: the runner keeps processing mail through a shutdown, against
    // storage that is already closing.
    installManager([
      { workflowId: 'w1', extensionId: 'vip', permissions: ['email:label'], result: labelResult('vip') },
    ]);

    startExtensionWorkflowRunner();
    stopExtensionWorkflowRunner();

    expect(h.unsubCalls.sort()).toEqual(['email:body-ready', 'email:synced']);
  });

  it('can be restarted after a stop', async () => {
    // Regression: stop leaves the "already subscribed" guard set, so a restart
    // silently listens to nothing.
    const calls = installManager([
      { workflowId: 'w1', extensionId: 'vip', permissions: ['email:label'], result: labelResult('vip') },
    ]);
    h.storageByEmail.set('e1', makeStorage({ e1: makeEmail('e1') }));

    startExtensionWorkflowRunner();
    stopExtensionWorkflowRunner();
    h.busHandlers.clear();
    startExtensionWorkflowRunner();
    emitSynced(makeEmail('e1'));
    await settle();

    expect(calls).toHaveLength(1);
  });

  it('survives an unsubscribe that throws', async () => {
    // Regression: a bus already torn down takes the whole quit sequence with it.
    installManager([
      { workflowId: 'w1', extensionId: 'vip', permissions: ['email:label'], result: labelResult('vip') },
    ]);

    startExtensionWorkflowRunner();
    h.unsubCalls.push = () => {
      throw new Error('bus gone');
    };

    expect(() => stopExtensionWorkflowRunner()).not.toThrow();
  });
});
