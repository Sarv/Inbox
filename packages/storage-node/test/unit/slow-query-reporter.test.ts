import { afterEach, describe, expect, it } from 'vitest';

import { reportSlowQuery, setSlowQueryReporter, type SlowQueryEvent } from '../../src/slow-query-reporter';

// The registry is the ONLY seam between the DB layer and the host app's
// telemetry. Two invariants matter for users: (1) diagnostics must never break a
// real query — a host reporter that throws (Sentry not initialised, network
// down) has to be swallowed here, because the caller is mid-query and a throw
// would surface as a failed mail operation; (2) unregistering must actually
// unregister, otherwise a torn-down window keeps receiving events forever.

// The registry is module-level global state — always hand it back so a leaked
// reporter can't capture events from unrelated suites.
afterEach(() => {
  setSlowQueryReporter(null);
});

describe('slow-query reporter registry', () => {
  it('is a no-op when no reporter is registered', () => {
    expect(() => reportSlowQuery({ label: 'noSink', ms: 99 })).not.toThrow();
  });

  it('forwards the whole event object, unchanged, to the registered reporter', () => {
    const seen: SlowQueryEvent[] = [];
    setSlowQueryReporter((event) => { seen.push(event); });

    const event: SlowQueryEvent = {
      label: 'getSectionByThreads',
      ms: 4321,
      rows: 50,
      totalEmails: 11000,
      meta: { folderPath: 'INBOX' },
    };
    reportSlowQuery(event);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(event);
    // Same reference — no defensive copy, so hosts can rely on meta identity.
    expect(seen[0]).toBe(event);
  });

  it('swallows a THROWING reporter so a broken telemetry sink cannot fail the query', () => {
    setSlowQueryReporter(() => { throw new Error('sentry not initialised'); });
    expect(() => reportSlowQuery({ label: 'boom', ms: 100 })).not.toThrow();
  });

  it('replaces the previous reporter, and setSlowQueryReporter(null) unregisters', () => {
    const first: string[] = [];
    const second: string[] = [];
    setSlowQueryReporter((e) => { first.push(e.label); });
    setSlowQueryReporter((e) => { second.push(e.label); });

    reportSlowQuery({ label: 'a', ms: 41 });
    expect(first).toEqual([]);        // replaced, not appended to
    expect(second).toEqual(['a']);

    setSlowQueryReporter(null);
    reportSlowQuery({ label: 'b', ms: 41 });
    expect(second).toEqual(['a']);    // nothing delivered after unregistering
  });
});
