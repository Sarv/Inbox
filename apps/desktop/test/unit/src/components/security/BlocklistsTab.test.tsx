// @vitest-environment happy-dom
import { BLOCKLISTS } from '@sarv-in/mailguard/reputation';
import { readBlocklistPrefs } from '@sarvinbox/core/blocklist-prefs';
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
 * control's "Off" shown — and saved — as on; or a mistyped Sarv address stored
 * and used, carrying the user's bearer token over plain http.
 */
const KEY = 'sarvinbox-settings';
const CATALOGUE = BLOCKLISTS.map((list) => list.name);
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? '{}');
/** What main would ask, read the way main reads it. */
const inForce = () => readBlocklistPrefs(stored(), CATALOGUE);

let mounted: Mounted | null = null;
const open = () => { mounted = render(<BlocklistsTab />); return mounted; };
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

beforeEach(() => { localStorage.clear(); });
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
});

describe('what the tab shows', () => {
  it('shows a fresh install’s default: every list through this computer’s DNS, links off, registration dates on', () => {
    open();
    expect(control(MASTER).checked).toBe(true);
    expect(control(LOCAL).checked).toBe(true);
    for (const list of BLOCKLISTS) expect(control(`Query ${list.zone}`).checked).toBe(true);
    expect(control(LINKS).checked).toBe(false);
    expect(control(AGE).checked).toBe(true);
  });

  // Regression: "Off — judge from headers alone" under the retired control was
  // an explicit no. The one control must show it as off, lists and dates.
  it('shows the retired Settings > General "Off" as off', () => {
    localStorage.setItem(KEY, JSON.stringify({ spamReputationMode: 'off', reputation: { enabled: false, zones: [], servers: [] } }));
    open();
    expect(control(MASTER).checked).toBe(false);
    expect(control(AGE).checked).toBe(false);
  });

  it('shows a configured Sarv service as the provider, with its address and report opt-in, and no DNS lists', () => {
    localStorage.setItem(KEY, JSON.stringify({ spamReputationMode: 'sarv', spamReputationEndpoint: 'https://rep.sarv.example', spamReputationReports: true }));
    open();
    expect(control(SARV).checked).toBe(true);
    expect(control(ADDRESS).value).toBe('https://rep.sarv.example');
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
  it('writes the whole section marked as chosen, keeps the rest of the blob, and outranks the retired fields', () => {
    localStorage.setItem(KEY, JSON.stringify({ signatures: [{ id: 's1' }], spamReputationMode: 'off', reputation: { enabled: false, zones: [], servers: [] } }));
    open();
    fire(control(MASTER), 'click');

    expect(stored().signatures).toEqual([{ id: 's1' }]);
    expect(stored().reputation).toEqual({
      enabled: true, provider: 'local', zones: CATALOGUE, servers: [], endpoint: '', reports: false,
      links: false, domainAge: false, chosen: true,
    });
    expect(inForce()).toMatchObject({ enabled: true, domainAge: false });
  });

  it('stops asking a list the user unticks, asks it again when re-ticked, and switches who is asked', () => {
    open();
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
  it('stores a Sarv address only when it is https, and keeps what was typed on screen', () => {
    open();
    fire(control(SARV), 'click');
    typeAndLeave(control(ADDRESS), 'http://rep.sarv.example');
    expect(inForce().endpoint).toBe('');
    expect(control(ADDRESS).value).toBe('http://rep.sarv.example');
    expect(mounted!.container.textContent).toContain('has to start with https://');

    typeAndLeave(control(ADDRESS), ' https://rep.sarv.example/ ');
    expect(inForce().endpoint).toBe('https://rep.sarv.example');
    expect(control(ADDRESS).value).toBe('https://rep.sarv.example');
  });

  it('saves the resolvers, link lookups, report sharing and registration dates as chosen', () => {
    open();
    typeAndLeave(control('Resolver addresses for blocklist queries'), '10.0.0.1, 10.0.0.2 ');
    fire(control(LINKS), 'click');
    fire(control(AGE), 'click');
    fire(control(SARV), 'click');
    fire(control(REPORTS), 'click');
    expect(inForce()).toMatchObject({ servers: ['10.0.0.1', '10.0.0.2'], links: true, domainAge: false, reports: true, chosen: true });
  });

  // "On" with every list unticked asks nobody — and says so, rather than
  // leaving the user to discover it as a silence.
  it('warns when the switch is on but no list is ticked', () => {
    open();
    for (const list of BLOCKLISTS) fire(control(`Query ${list.zone}`), 'click');
    expect(inForce()).toMatchObject({ enabled: true, zones: [] });
    expect(mounted!.container.textContent).toContain('No list is selected, so nothing will be asked.');
  });

  // With the switch off there is nothing for link lookups to ride on.
  it('offers link lookups only while the switch is on', () => {
    open();
    fire(control(MASTER), 'click');
    expect(control(LINKS).disabled).toBe(true);
  });
});
