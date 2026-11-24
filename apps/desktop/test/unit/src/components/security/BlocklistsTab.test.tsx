// @vitest-environment happy-dom
import { BLOCKLISTS } from '@sarv-in/mailguard/reputation';
import { readBlocklistPrefs } from '@sarvinbox/core/blocklist-prefs';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlocklistsTab } from '../../../../../src/components/security/BlocklistsTab';
import { fire, render, type Mounted } from '../../../../helpers/render';

/**
 * Security > Blocklists — the ONE control for who is told about incoming mail.
 *
 * What breaks if this file goes red: the tab shows one thing while main asks
 * another (both read the blob through core's `readBlocklistPrefs`); a save
 * that is not marked as the user's choice, so a later migration flips it; a
 * save that drops the rest of the blob; the retired Settings > General
 * control's "Off" shown — and saved — as on; a mistyped Sarv address stored
 * and used, carrying the user's bearer token over plain http; or Sarv's
 * reputation service offered while main has no address for it (no build has
 * one until the service runs).
 */
const KEY = 'sarvinbox-settings';
const CATALOGUE = BLOCKLISTS.map((list) => list.name);
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? '{}');
/** What main would ask, read the way main reads it. */
const inForce = () => readBlocklistPrefs(stored(), CATALOGUE);

/** The reputation origin main's registry has for these tests (a dev build's override). */
const SARV_REP = 'https://reputation.sarv.test';
/**
 * What `oauth:listProviders` reports as Sarv's reputation origin: null as every
 * build ships, 'fail' for a channel that rejects, 'pending' for one that has
 * not answered yet.
 */
let reported: string | null | 'fail' | 'pending' = null;

let mounted: Mounted | null = null;
/** Mount the tab and let main's answer about the Sarv origin arrive. */
const open = async () => {
  mounted = render(<BlocklistsTab />);
  await act(async () => {});
  return mounted;
};
const control = (label: string) => {
  const el = mounted!.byLabel(label);
  if (!el) throw new Error(`no control labelled ${label}`);
  return el as HTMLInputElement;
};
/** Type into a controlled input the way a user does, then leave it. */
const typeAndLeave = (el: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  fire(el, 'input');
  fire(el, 'focusout');
};

const MASTER = 'Ask blocklists about incoming mail';
const LINKS = 'Also ask about the domains a message links to';
const LOCAL = "Ask the lists through this computer's DNS";
const SARV = 'Ask the Sarv reputation service';
const ADDRESS = 'Sarv reputation service address';
const REPORTS = 'Share my Report spam and Not spam verdicts';
const AGE = 'Check how recently sender and link domains were registered';

beforeEach(() => {
  localStorage.clear();
  reported = SARV_REP;
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    oauth: {
      listProviders: () => {
        if (reported === 'fail') return Promise.reject(new Error('ipc down'));
        if (reported === 'pending') return new Promise(() => {});
        return Promise.resolve({
          success: true,
          data: [{ id: 'gmail', reputationOrigin: null }, { id: 'sarv', reputationOrigin: reported }],
        });
      },
    },
  };
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

describe('what the tab shows', () => {
  it('shows a fresh install’s default: every list through this computer’s DNS, links off, registration dates on', async () => {
    await open();
    expect(control(MASTER).checked).toBe(true);
    expect(control(LOCAL).checked).toBe(true);
    for (const list of BLOCKLISTS) expect(control(`Query ${list.zone}`).checked).toBe(true);
    expect(control(LINKS).checked).toBe(false);
    expect(control(AGE).checked).toBe(true);
  });

  // Regression: "Off — judge from headers alone" under the retired control was
  // an explicit no. The one control must show it as off, lists and dates.
  it('shows the retired Settings > General "Off" as off', async () => {
    localStorage.setItem(KEY, JSON.stringify({ spamReputationMode: 'off', reputation: { enabled: false, zones: [], servers: [] } }));
    await open();
    expect(control(MASTER).checked).toBe(false);
    expect(control(AGE).checked).toBe(false);
  });

  it('shows a configured Sarv service as the provider, with its address and report opt-in, and no DNS lists', async () => {
    localStorage.setItem(KEY, JSON.stringify({ spamReputationMode: 'sarv', spamReputationEndpoint: SARV_REP, spamReputationReports: true }));
    await open();
    expect(control(SARV).checked).toBe(true);
    expect(control(ADDRESS).value).toBe(SARV_REP);
    expect(control(REPORTS).checked).toBe(true);
    expect(control(LINKS).checked).toBe(true);
    expect(mounted!.byLabel(`Query ${BLOCKLISTS[0]!.zone}`)).toBeNull();
  });
});

describe('what the tab saves', () => {
  // THE contract with main: every save writes the complete section, marked as
  // the user's, beside everything else in the blob — and from then on the
  // retired fields left in the blob are ignored, so their "Off" cannot
  // override a switch the user just turned on.
  it('writes the whole section marked as chosen, keeps the rest of the blob, and outranks the retired fields', async () => {
    localStorage.setItem(KEY, JSON.stringify({ signatures: [{ id: 's1' }], spamReputationMode: 'off', reputation: { enabled: false, zones: [], servers: [] } }));
    await open();
    fire(control(MASTER), 'click');

    expect(stored().signatures).toEqual([{ id: 's1' }]);
    expect(stored().reputation).toEqual({
      enabled: true, provider: 'local', zones: CATALOGUE, servers: [], endpoint: '', reports: false,
      links: false, domainAge: false, chosen: true,
    });
    expect(inForce()).toMatchObject({ enabled: true, domainAge: false });
  });

  it('stops asking a list the user unticks, asks it again when re-ticked, and switches who is asked', async () => {
    await open();
    fire(control('Query bl.spamcop.net'), 'click');
    expect(inForce().zones).not.toContain('spamcop');
    fire(control('Query bl.spamcop.net'), 'click');
    expect(inForce().zones).toContain('spamcop');
    fire(control('Query bl.spamcop.net'), 'click');

    fire(control(SARV), 'click');
    expect(inForce().provider).toBe('sarv');
    expect(mounted!.byLabel('Query bl.spamcop.net')).toBeNull();
    fire(control(LOCAL), 'click');
    expect(inForce()).toMatchObject({ provider: 'local', zones: CATALOGUE.filter((name) => name !== 'spamcop') });
  });

  // Regression: an http address would send the bearer token in the clear. It
  // is stored as NO address — nothing is asked — while the screen keeps what
  // was typed, with the reason, rather than silently erasing it.
  it('stores a Sarv address only when it is https, and keeps what was typed on screen', async () => {
    await open();
    fire(control(SARV), 'click');
    typeAndLeave(control(ADDRESS), 'http://rep.sarv.example');
    expect(inForce().endpoint).toBe('');
    expect(control(ADDRESS).value).toBe('http://rep.sarv.example');
    expect(mounted!.container.textContent).toContain('has to start with https://');

    // Behaviour changed (reputation-token fix): only the reputation origin main
    // reports is asked, so that is the https address this stores and accepts.
    typeAndLeave(control(ADDRESS), ' https://reputation.sarv.test/ ');
    expect(inForce().endpoint).toBe(SARV_REP);
    expect(control(ADDRESS).value).toBe(SARV_REP);
    expect(mounted!.container.textContent).not.toContain('has to start with https://');
    expect(mounted!.container.textContent).not.toContain('Only Sarv’s reputation service');
  });

  // Breaks: the tab shows an https address as accepted that main will never
  // ask (it is not Sarv's), so the user believes blocklists are working; or the
  // typed address is erased instead of shown with the reason.
  it('warns, and keeps what was typed, for an https address that is not Sarv’s', async () => {
    await open();
    fire(control(SARV), 'click');
    typeAndLeave(control(ADDRESS), 'https://rep.sarv.example');
    expect(control(ADDRESS).value).toBe('https://rep.sarv.example');
    expect(inForce().endpoint).toBe('https://rep.sarv.example'); // main reads it, and refuses it
    const text = mounted!.container.textContent ?? '';
    expect(text).toContain('Only Sarv’s reputation service, https://reputation.sarv.test, can be asked');
    expect(text).toContain('Nothing is asked until the address is Sarv’s.');
    expect(text).not.toContain('has to start with https://');
    expect(control(ADDRESS).placeholder).toBe(SARV_REP);
  });

  // Breaks: the tab judges the typed address against its own copy of the
  // registry, which never carries a dev build's override, so the dev service
  // is flagged as "not Sarv's" while main asks it (and a lookalike passes).
  it('checks the address against the origin main reports, not this window’s registry', async () => {
    reported = 'https://rep.dev.example';
    await open();
    fire(control(SARV), 'click');
    typeAndLeave(control(ADDRESS), 'https://REP.dev.example/');
    expect(mounted!.container.textContent).not.toContain('Only Sarv’s reputation service');
    typeAndLeave(control(ADDRESS), SARV_REP);
    expect(mounted!.container.textContent).toContain('Only Sarv’s reputation service, https://rep.dev.example, can be asked');
  });

  it('saves the resolvers, link lookups, report sharing and registration dates as chosen', async () => {
    await open();
    typeAndLeave(control('Resolver addresses for blocklist queries'), '10.0.0.1, 10.0.0.2 ');
    fire(control(LINKS), 'click');
    fire(control(AGE), 'click');
    fire(control(SARV), 'click');
    fire(control(REPORTS), 'click');
    expect(inForce()).toMatchObject({ servers: ['10.0.0.1', '10.0.0.2'], links: true, domainAge: false, reports: true, chosen: true });
  });

  // "On" with every list unticked asks nobody — and says so, rather than
  // leaving the user to discover it as a silence.
  it('warns when the switch is on but no list is ticked', async () => {
    await open();
    for (const list of BLOCKLISTS) fire(control(`Query ${list.zone}`), 'click');
    expect(inForce()).toMatchObject({ enabled: true, zones: [] });
    expect(mounted!.container.textContent).toContain('No list is selected, so nothing will be asked.');
  });

  // With the switch off there is nothing for link lookups to ride on.
  it('offers link lookups only while the switch is on', async () => {
    await open();
    fire(control(MASTER), 'click');
    expect(control(LINKS).disabled).toBe(true);
  });
});

/**
 * Sarv's reputation service is not running yet, so main has no address for it
 * in any build, and the tab must not offer it. A choice saved when it was
 * offered stays visible, off, with the reason, so the user can change it.
 */
describe('with no Sarv reputation service, as every build ships', () => {
  beforeEach(() => { reported = null; });

  // Breaks: the tab offers a service that does not exist, so a user picks it
  // and blocklists silently stop; or the intro still says lookups may go to Sarv.
  it('does not offer the Sarv service, and says lookups go to the list operators', async () => {
    await open();
    expect(mounted!.byLabel(SARV)).toBeNull();
    expect(control(LOCAL).checked).toBe(true);
    const text = mounted!.container.textContent ?? '';
    expect(text).toContain('to the blocklist operators below, over DNS,');
    expect(text).not.toContain('or Sarv’s reputation service');
  });

  // Breaks: a Sarv choice saved before vanishes from the tab (no radio is
  // checked and nothing explains why blocklists ask nobody), or its address
  // and report opt-in stay on screen as if they did something, or the tab
  // moves the user to this computer's DNS without asking.
  it('keeps a saved Sarv choice visible and off, says why, and lets the user move to DNS', async () => {
    localStorage.setItem(KEY, JSON.stringify({ spamReputationMode: 'sarv', spamReputationEndpoint: 'https://reputation.sarv.com', spamReputationReports: true }));
    await open();
    expect(control(SARV).checked).toBe(true);
    expect(inForce().provider).toBe('sarv');
    const text = mounted!.container.textContent ?? '';
    expect(text).toContain('Not available yet. Nothing is asked while this is chosen.');
    expect(text).toContain('Sarv’s reputation service is not available yet, so no blocklist is asked');
    expect(mounted!.byLabel(ADDRESS)).toBeNull();
    expect(mounted!.byLabel(REPORTS)).toBeNull();

    fire(control(LOCAL), 'click');
    expect(inForce().provider).toBe('local');
    expect(control(`Query ${BLOCKLISTS[0]!.zone}`).checked).toBe(true);
    expect(mounted!.byLabel(SARV)).toBeNull(); // not offered, and no longer chosen
  });

  // Breaks: a channel failure is read as "Sarv is available" and the choice is
  // offered with no address to check against.
  it('offers no Sarv choice when main cannot be asked', async () => {
    reported = 'fail';
    await open();
    expect(mounted!.byLabel(SARV)).toBeNull();
  });

  // Breaks: before main answers, a saved Sarv choice flashes the address
  // field, or the "not available" note, which may both be wrong.
  it('shows neither the address field nor the note until main has answered', async () => {
    reported = 'pending';
    localStorage.setItem(KEY, JSON.stringify({ spamReputationMode: 'sarv', spamReputationEndpoint: SARV_REP }));
    await open();
    expect(control(SARV).checked).toBe(true);
    expect(mounted!.byLabel(ADDRESS)).toBeNull();
    expect(mounted!.container.textContent).not.toContain('not available yet');
  });
});
