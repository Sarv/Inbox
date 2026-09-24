// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Security } from '../../../../../src/components/security/Security';
import { act, fire, render, settle, type Mounted } from '../../../../helpers/render';

/**
 * The Overview's reputation card — the one place that says, in words, who is
 * told about the user's incoming mail.
 *
 * What breaks if this file goes red: the card names the wrong party (or none)
 * for the blocklist lookups made as mail arrives, sends the user to the
 * Settings > General control that no longer exists, or offers "Run now" for a
 * background pass that has nothing to do.
 */
type State = {
  pending: number; judged: number; filed: number; linkPending: number; linkJudged: number;
  blocklists: string | null; linkProvider: string | null; domainAge: boolean; ageChecked: number;
  notes: string[]; running: boolean; lastRun: number | null;
};
const base: State = {
  pending: 0, judged: 0, filed: 0, linkPending: 0, linkJudged: 0, blocklists: 'local-dnsbl', linkProvider: null,
  domainAge: true, ageChecked: 0, notes: [], running: false, lastRun: null,
};

let mounted: Mounted | null = null;
let progress: ((state: State) => void) | null = null;
const kickReputation = vi.fn(async () => ({ success: true }));

const mount = async (state: Partial<State>) => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    security: { getHeaderBackfillState: async () => ({ success: false }), onHeaderBackfillProgress: () => () => {} },
    spam: {
      getReputationState: async () => ({ success: true, data: { ...base, ...state } }),
      onReputationProgress: (cb: (s: State) => void) => { progress = cb; return () => { progress = null; }; },
      kickReputation,
    },
  };
  mounted = render(<Security initialTab="overview" />);
  await settle();
  return mounted;
};
const text = () => mounted!.container.textContent ?? '';
const runNow = () => mounted!.all('button').find((b) => b.textContent === 'Run now') ?? null;

beforeEach(() => { kickReputation.mockClear(); });
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  progress = null;
  document.body.innerHTML = '';
});

describe('the reputation card', () => {
  it('names this computer’s DNS as who is asked about every arriving sender, and what the background pass did', async () => {
    await mount({ judged: 3, linkJudged: 2, filed: 1, pending: 4, ageChecked: 7 });
    expect(text()).toContain('Blocklists are asked about every arriving sender through this computer’s DNS.');
    expect(text()).toContain('Background checks: 5 messages judged this session, 1 filed as spam by them, 4 waiting.');
    expect(text()).toContain('7 domain registration dates looked up.');
    expect(text()).not.toContain('Settings → General');
  });

  it('names the Sarv service, and says when link domains are asked about too', async () => {
    await mount({ blocklists: 'sarv', linkProvider: 'sarv' });
    expect(text()).toContain('through the Sarv reputation service, and about the domains a message links to once its body is downloaded.');
  });

  // Regression: the old card pointed at a Settings > General control that no
  // longer exists. Off is changed where it is set.
  it('says blocklists are off, and where to change that', async () => {
    await mount({ blocklists: null, domainAge: false });
    expect(text()).toContain('Blocklists are off');
    expect(text()).toContain('Change this under Security → Blocklists.');
    expect(text()).not.toContain('Background checks');
  });

  // "Run now" pulls the background pass forward; with neither link lookups
  // nor registration dates on there is no pass to pull.
  it('offers Run now only when the background pass has something to do', async () => {
    await mount({ domainAge: true });
    fire(runNow(), 'click');
    expect(kickReputation).toHaveBeenCalledTimes(1);
    mounted!.unmount();
    mounted = null;

    await mount({ domainAge: false, linkProvider: null });
    expect(runNow()).toBeNull();
  });

  it('follows the pass’s progress as it is pushed', async () => {
    await mount({ judged: 0 });
    act(() => progress!({ ...base, judged: 12, notes: ['Spamhaus ZEN: the query arrived via a public or open resolver'] }));
    expect(text()).toContain('12 messages judged this session');
    expect(text()).toContain('Spamhaus ZEN: the query arrived via a public or open resolver');
  });
});
