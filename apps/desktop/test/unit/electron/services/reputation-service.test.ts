import { describe, expect, it, vi } from 'vitest';

/**
 * Blocklist settings -> the process-wide lookup.
 *
 * What this guards is the disclosure boundary, not the DNS: the stage itself
 * (cache, de-duplication, circuit breaker) is covered in the core suite. Here
 * the regressions all have the same shape — a query going out that the user
 * never asked for, or a setting the user did ask for never reaching the stage.
 */

const h = vi.hoisted(() => ({
  /** Every ReputationStage this test built, oldest first. */
  built: [] as Array<{ config: { blocklists: Array<{ name: string }>; servers?: readonly string[] } }>,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/reputation-service-test', getName: () => 'Sarv Inbox Test', isPackaged: false },
}));

vi.mock(
  '../../../../electron/services/core-db',
  async () => await import('../../../../electron/services/__testing__/fake-core-db'),
);

vi.mock('@sarvinbox/core', async () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {} }),
  // The real reader: which lists are queried is exactly what this suite guards.
  readBlocklistPrefs: (await import('../../../../../../packages/core/src/utils/blocklist-prefs')).readBlocklistPrefs,
  // A stand-in that records the configuration it was handed and answers a
  // fixed assessment, so a test can see BOTH which zones were configured and
  // whether the lookup reached a stage at all.
  ReputationStage: class {
    constructor(public config: { blocklists: Array<{ name: string }>; servers?: readonly string[] }) {
      h.built.push(this as never);
    }
    async assess(): Promise<{ score: number; reasons: never[]; isSpam: boolean; suspicious: boolean }> {
      return { score: 4, reasons: [], isSpam: false, suspicious: true };
    }
  },
}));

type Service = typeof import('../../../../electron/services/reputation-service');
type FakeDb = typeof import('../../../../electron/services/__testing__/fake-core-db');

const SETTINGS_KEY = 'sarvinbox-settings';

/** A fresh module (the stage is module-scoped) over a fresh fake core DB. */
const setup = async (
  reputation?: unknown,
  extra: Record<string, unknown> = {},
): Promise<{ service: Service; db: FakeDb['state'] }> => {
  vi.resetModules();
  h.built.length = 0;
  const fake = await import('../../../../electron/services/__testing__/fake-core-db');
  fake.resetFakeCoreDb();
  if (reputation !== undefined) {
    fake.setAppSetting(SETTINGS_KEY, JSON.stringify({ ...extra, reputation }));
  }
  const service = await import('../../../../electron/services/reputation-service');
  return { service, db: fake.state };
};

/** A sync engine, as far as this service is concerned. */
const fakeEngine = () => {
  const engine = {
    lookup: null as null | ((subject: { ip?: string | null }) => Promise<unknown>),
    setReputationLookup(fn: (subject: { ip?: string | null }) => Promise<unknown>) {
      engine.lookup = fn;
    },
  };
  return engine;
};

describe('readReputationSettings', () => {
  it('reads the zones and resolvers the user chose', async () => {
    const { service } = await setup();

    expect(
      service.readReputationSettings({
        [SETTINGS_KEY]: JSON.stringify({
          reputation: { enabled: true, zones: ['spamhaus-zen'], servers: [' 10.0.0.1 ', '10.0.0.2'] },
        }),
      }),
    ).toEqual({ enabled: true, zones: ['spamhaus-zen'], servers: ['10.0.0.1', '10.0.0.2'] });
  });

  // Behaviour changed 2026-09-23: blocklists are on by default, every zone.
  // An absent or unreadable section reads as those defaults, never as a
  // throw at boot. An EXPLICIT section is still read literally — "truthy" is
  // not "true", and a zone list that is not a list is no zones — so a user
  // who turned lists off stays off whatever else the blob has suffered.
  it('reads an absent or unreadable section as the defaults, and an explicit one literally', async () => {
    const { service } = await setup();
    const defaults = { enabled: true, zones: [...service.DEFAULT_ZONES], servers: [] };
    expect(defaults.zones).toEqual(['spamhaus-zen', 'spamhaus-dbl', 'spamcop', 'barracuda', 'surbl', 'uribl']);

    expect(service.readReputationSettings({})).toEqual(defaults);
    expect(service.readReputationSettings({ [SETTINGS_KEY]: 'not json' })).toEqual(defaults);
    expect(service.readReputationSettings({ [SETTINGS_KEY]: '{}' })).toEqual(defaults);
    expect(service.readReputationSettings({ [SETTINGS_KEY]: '{"reputation":null}' })).toEqual(defaults);
    expect(service.readReputationSettings({ [SETTINGS_KEY]: '{"reputation":"yes"}' })).toEqual(defaults);
    expect(
      service.readReputationSettings({ [SETTINGS_KEY]: '{"reputation":{"enabled":1,"zones":"all"}}' }),
    ).toEqual({ enabled: false, zones: [], servers: [] });
    expect(
      service.readReputationSettings({ [SETTINGS_KEY]: '{"reputation":{"enabled":false,"zones":["spamcop"],"servers":[]}}' }),
    ).toEqual({ enabled: false, zones: ['spamcop'], servers: [] });
  });

  // THE migration, end to end on the main side: every install that ever saved
  // Settings has the old default stored as an explicit "off". It must read as
  // the new default — and a section the Blocklists tab marked must not.
  it('reads the old saved "off" as the new default, but honours an off the user chose', async () => {
    const { service } = await setup();
    const blob = (reputation: unknown) => ({ [SETTINGS_KEY]: JSON.stringify({ signatures: [], reputation }) });

    expect(service.readReputationSettings(blob({ enabled: false, zones: [], servers: [] }))).toEqual(
      service.DEFAULT_REPUTATION_SETTINGS,
    );
    expect(service.readReputationSettings(blob({ enabled: false, zones: [], servers: [], chosen: true }))).toEqual({
      enabled: false,
      zones: [],
      servers: [],
      chosen: true,
    });
  });

  // Regression: a zone name this build does not know must be dropped, never
  // passed through. Otherwise a typo (or a settings blob from a newer build)
  // becomes a query to a zone nobody in this process can describe.
  it('drops zone names that are not in this build catalogue', async () => {
    const { service } = await setup();

    expect(
      service.readReputationSettings({
        [SETTINGS_KEY]: JSON.stringify({
          reputation: { enabled: true, zones: ['spamhaus-zen', 'made-up.example', 42], servers: [] },
        }),
      }).zones,
    ).toEqual(['spamhaus-zen']);
  });
});

describe('attachReputation', () => {
  // The default, and the one that matters most: a fresh install asks every
  // catalogue zone from its first message, through the system resolver, with
  // no setting touched. (Behaviour changed 2026-09-23; it used to ask nobody.)
  it('wires a lookup that asks every catalogue zone out of the box', async () => {
    const { service } = await setup();
    const engine = fakeEngine();

    service.attachReputation(engine);

    expect(engine.lookup).toBeTypeOf('function');
    await expect(engine.lookup!({ ip: '185.199.108.1' })).resolves.toMatchObject({ score: 4 });
    expect(h.built).toHaveLength(1);
    expect(h.built[0]!.config.blocklists.map((list) => list.name)).toEqual([...service.DEFAULT_ZONES]);
    expect(h.built[0]!.config.servers).toEqual([]);
  });

  // `chosen` is what the Blocklists tab writes: without it this exact shape
  // is the old saved default, which the migration reads as ON.
  it('asks nobody once the user has turned the lists off', async () => {
    const { service } = await setup({ enabled: false, zones: [], servers: [], chosen: true });
    const engine = fakeEngine();

    service.attachReputation(engine);

    await expect(engine.lookup!({ ip: '185.199.108.1' })).resolves.toBeNull();
    expect(h.built).toHaveLength(0);
  });

  it('builds the stage from the chosen zones and resolvers, and scores through it', async () => {
    const { service } = await setup({
      enabled: true,
      zones: ['spamhaus-zen', 'spamhaus-dbl'],
      servers: ['10.0.0.1'],
    });
    const engine = fakeEngine();

    service.attachReputation(engine);

    expect(h.built).toHaveLength(1);
    expect(h.built[0]!.config.blocklists.map((list) => list.name)).toEqual([
      'spamhaus-zen',
      'spamhaus-dbl',
    ]);
    expect(h.built[0]!.config.servers).toEqual(['10.0.0.1']);
    await expect(engine.lookup!({ ip: '185.199.108.1' })).resolves.toMatchObject({ score: 4 });
  });

  // Regression: "on" with nothing selected is not a reason to query anything,
  // and building a stage with an empty zone list would be a stage that runs a
  // lookup, caches a verdict and finds nothing, forever.
  it('stays off when it is enabled but no list is selected', async () => {
    const { service } = await setup({ enabled: true, zones: [], servers: [] });
    const engine = fakeEngine();

    service.attachReputation(engine);

    expect(h.built).toHaveLength(0);
    await expect(engine.lookup!({ ip: '185.199.108.1' })).resolves.toBeNull();
  });

  // Regression: one stage for the process. Two accounts receiving the same
  // newsletter must ask the operator once between them, not once each.
  it('gives every engine the same lookup', async () => {
    const { service } = await setup({ enabled: true, zones: ['spamhaus-zen'], servers: [] });
    const first = fakeEngine();
    const second = fakeEngine();

    service.attachReputation(first);
    service.attachReputation(second);

    expect(h.built).toHaveLength(1);
    expect(first.lookup).toBe(second.lookup);
  });
});

describe('noteAppSettingChanged', () => {
  // Regression: a zone added in Settings must be queried on the next message,
  // not after the next restart. The engine is never re-wired, so this only
  // works if the lookup reads the CURRENT stage rather than capturing one.
  it('reaches an already-wired engine when the settings change', async () => {
    const { service, db } = await setup({ enabled: false, zones: [], servers: [], chosen: true });
    const engine = fakeEngine();
    service.attachReputation(engine);
    await expect(engine.lookup!({ ip: '185.199.108.1' })).resolves.toBeNull();

    db.settings.set(
      SETTINGS_KEY,
      JSON.stringify({ reputation: { enabled: true, zones: ['spamcop'], servers: [] } }),
    );
    service.noteAppSettingChanged(SETTINGS_KEY);

    expect(h.built).toHaveLength(1);
    await expect(engine.lookup!({ ip: '185.199.108.1' })).resolves.toMatchObject({ score: 4 });
  });

  // Regression: switching it off has to stop the queries immediately, for the
  // same reason switching it on has to start them immediately.
  it('stops asking when the user turns it off', async () => {
    const { service, db } = await setup({ enabled: true, zones: ['spamcop'], servers: [] });
    const engine = fakeEngine();
    service.attachReputation(engine);

    db.settings.set(
      SETTINGS_KEY,
      JSON.stringify({ reputation: { enabled: false, zones: ['spamcop'], servers: [] } }),
    );
    service.noteAppSettingChanged(SETTINGS_KEY);

    await expect(engine.lookup!({ ip: '185.199.108.1' })).resolves.toBeNull();
  });

  // Regression: the cache holds verdicts reached under the OLD zone list. A
  // user who has just added a zone expects the next message to be asked about,
  // so a real change must build a new stage rather than reuse the old one.
  it('rebuilds the stage, and its cache, when the zone list changes', async () => {
    const { service, db } = await setup({ enabled: true, zones: ['spamcop'], servers: [] });
    service.attachReputation(fakeEngine());
    expect(h.built).toHaveLength(1);

    db.settings.set(
      SETTINGS_KEY,
      JSON.stringify({ reputation: { enabled: true, zones: ['spamcop', 'spamhaus-zen'], servers: [] } }),
    );
    service.noteAppSettingChanged(SETTINGS_KEY);

    expect(h.built).toHaveLength(2);
    expect(h.built[1]!.config.blocklists.map((list) => list.name)).toEqual(['spamcop', 'spamhaus-zen']);
  });

  // Regression: the settings blob is written on every unrelated change — a
  // signature edit, a view-mode toggle. Rebuilding on each one would throw the
  // cache away constantly and turn a quiet feature into steady DNS traffic.
  it('keeps the same stage when the blob changes but this section does not', async () => {
    const { service, db } = await setup({ enabled: true, zones: ['spamcop'], servers: [] });
    service.attachReputation(fakeEngine());

    db.settings.set(
      SETTINGS_KEY,
      JSON.stringify({
        signature: 'a new signature',
        reputation: { enabled: true, zones: ['spamcop'], servers: [] },
      }),
    );
    service.noteAppSettingChanged(SETTINGS_KEY);

    expect(h.built).toHaveLength(1);
  });

  it('ignores every other settings key', async () => {
    const { service, db } = await setup({ enabled: true, zones: ['spamcop'], servers: [] });
    service.attachReputation(fakeEngine());

    db.settings.set(SETTINGS_KEY, JSON.stringify({ reputation: { enabled: true, zones: ['spamhaus-zen'], servers: [] } }));
    service.noteAppSettingChanged('sarvinbox-view-mode');

    expect(h.built).toHaveLength(1);
  });
});

describe('availableBlocklists', () => {
  // The settings UI renders this. If a zone stops appearing, the user simply
  // cannot choose it, with no error anywhere to say so.
  it('describes every zone this build can query', async () => {
    const { service } = await setup();

    const names = service.availableBlocklists().map((list) => list.name);
    expect(names).toEqual(expect.arrayContaining(['spamhaus-zen', 'spamhaus-dbl', 'spamcop']));
    expect(service.availableBlocklists().every((list) => list.zone.includes('.'))).toBe(true);
  });
});
