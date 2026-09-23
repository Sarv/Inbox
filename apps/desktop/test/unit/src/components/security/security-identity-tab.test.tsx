// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Security } from '../../../../../src/components/security/Security';
import { act, fire, render, settle, type Mounted } from '../../../../helpers/render';

/**
 * Security → Sender identity, the per-domain BIMI/favicon listing.
 *
 * What breaks if this file goes red: the only screen where a reader can see
 * WHY a domain's brand logo is or is not shown, and the only place the cached
 * answer can be refreshed or dropped. Two failure shapes are specific to it:
 *
 *  - The reason a status holds ("BIMI requires an enforcing DMARC policy; the
 *    domain's is p=none") is a whole sentence. Put it back in the cell and the
 *    auto-laid-out table hands that column every pixel, leaving the DOMAIN —
 *    the one thing identifying the row — spelled a few characters per line.
 *  - The lookup records a reason for a missing favicon too. It was being
 *    fetched, stored, and then never rendered, so "Unreachable" was a verdict
 *    with no evidence behind it.
 */

// The shared Tooltip opens on `mouseover` after `delayMs` and portals its body
// to document.body, so hovering is that event plus the timer.
const hover = async (element: HTMLElement | null) => {
  expect(element).not.toBeNull();
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
  await act(async () => {
    vi.advanceTimersByTime(100);
  });
};

const unhover = async (element: HTMLElement | null) => {
  await act(async () => {
    element!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    element!.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
  });
};

/** The tooltip bubble is the portalled node the component does not own. */
const tooltipText = () =>
  [...document.body.querySelectorAll('div.fixed.z-\\[9999\\]')]
    .map((node) => node.textContent ?? '')
    .join(' ');

const CHECKED_AT = 1_758_000_000; // unix seconds
const EXPIRES_AT = 1_790_000_000;

const row = (over: Record<string, unknown> = {}) => ({
  domain: 'deeperlearning.producthunt.com',
  bimiStatus: 'invalid',
  bimiLogo: null,
  bimiOrganization: null,
  bimiIssuer: null,
  bimiExpires: null,
  bimiDetail: "BIMI requires an enforcing DMARC policy; the domain's is p=none",
  bimiRecordDomain: 'producthunt.com',
  dmarcPolicy: 'none',
  bimiCheckedAt: CHECKED_AT,
  favicon: null,
  faviconStatus: 'error',
  faviconDetail: 'The homepage did not answer within 5s',
  faviconCheckedAt: CHECKED_AT,
  updatedAt: CHECKED_AT,
  ...over,
});

let rows: ReturnType<typeof row>[] = [];
const calls = { refresh: [] as string[], forget: [] as string[] };

const installElectronAPI = () => {
  (window as unknown as Record<string, unknown>).electronAPI = {
    emails: { getImageAllowedSenders: vi.fn(async () => ({ success: true, data: [] })) },
    identity: {
      list: vi.fn(async () => ({ success: true, data: rows })),
      refresh: vi.fn(async (domain: string) => { calls.refresh.push(domain); return { success: true }; }),
      forget: vi.fn(async (domain: string) => { calls.forget.push(domain); return { success: true }; }),
      onUpdated: vi.fn(() => () => {}),
    },
    spammers: { list: vi.fn(async () => ({ success: true, data: { spammers: [], total: 0 } })) },
  };
};

let mounted: Mounted;

const mountIdentityTab = async () => {
  mounted = render(<Security initialTab="identity" />);
  await settle();
  return mounted;
};

beforeEach(() => {
  vi.useFakeTimers();
  rows = [row()];
  calls.refresh.length = 0;
  calls.forget.length = 0;
  installElectronAPI();
  vi.clearAllMocks();
});

afterEach(() => {
  mounted?.unmount();
  vi.useRealTimers();
});

describe('Security → Sender identity', () => {
  it('keeps the reason out of the cell and behind the record icon', async () => {
    // THE layout bug: a sentence in the Brand cell starves every other column.
    // The cell may say the standing and nothing longer.
    await mountIdentityTab();

    const brandCell = mounted.all('tbody td')[1]!;
    expect(brandCell.textContent).toContain('Unusable');
    expect(brandCell.textContent).not.toContain('enforcing DMARC policy');

    await hover(mounted.byLabel('BIMI record for deeperlearning.producthunt.com'));
    expect(tooltipText()).toContain("BIMI requires an enforcing DMARC policy; the domain's is p=none");
  });

  it('names the zone the record was read from, which is not always the domain', async () => {
    // BIMI falls back to the organisational domain. A reader checking their own
    // DNS after reading this needs to know which zone actually answered.
    await mountIdentityTab();

    await hover(mounted.byLabel('BIMI record for deeperlearning.producthunt.com'));
    const text = tooltipText();
    expect(text).toContain('producthunt.com');
    expect(text).toContain('DMARC');
    expect(text).toContain('p=none');
    expect(text).toContain('CertificateNone'); // no certificate on this row
  });

  it('reports a published logo and its certificate', async () => {
    rows = [row({
      domain: 'example.com',
      bimiStatus: 'verified',
      bimiLogo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      bimiOrganization: 'Example Inc',
      bimiIssuer: 'DigiCert',
      bimiExpires: EXPIRES_AT,
      bimiDetail: 'Verified Mark Certificate chains to a pinned authority',
      bimiRecordDomain: 'example.com',
      dmarcPolicy: 'reject',
    })];
    await mountIdentityTab();

    await hover(mounted.byLabel('BIMI record for example.com'));
    const text = tooltipText();
    expect(text).toContain('Published'); // the logo
    expect(text).toContain('Example Inc');
    expect(text).toContain('issued by DigiCert');
    expect(text).toContain('expires');
    expect(text).toContain('p=reject');
  });

  it('says "never" for a domain that has not been looked up', async () => {
    rows = [row({ domain: 'fresh.test', bimiStatus: null, bimiRecordDomain: null, dmarcPolicy: null, bimiCheckedAt: null })];
    await mountIdentityTab();

    expect(mounted.all('tbody td')[1]!.textContent).toContain('Not looked up');
    await hover(mounted.byLabel('BIMI record for fresh.test'));
    const text = tooltipText();
    expect(text).toContain('never');
    expect(text).toContain('Not published'); // DMARC
  });

  it('never shreds the domain: it wraps on words, not on every character', async () => {
    // Regression: `break-all` makes the cell's min-content ONE character wide,
    // so the auto layout may squeeze the column to nothing. The domain is the
    // row's identity — it is the last thing that may be sacrificed for width.
    await mountIdentityTab();

    const domain = mounted.all('tbody td')[0]!.querySelector('span.font-medium')!;
    expect(domain.textContent).toBe('deeperlearning.producthunt.com');
    expect(domain.className).toContain('break-words');
    expect(domain.className).not.toContain('break-all');
  });

  it('explains an unreachable favicon instead of only labelling it', async () => {
    await mountIdentityTab();

    const faviconCell = mounted.all('tbody td')[2]!;
    expect(faviconCell.textContent).toContain('Unreachable');

    await hover(faviconCell.querySelector('span')! as HTMLElement);
    expect(tooltipText()).toContain('The homepage did not answer within 5s');
  });

  it('shows no favicon tooltip when the lookup recorded no reason', async () => {
    // An empty bubble on hover is worse than none: it reads as a failure to load.
    rows = [row({ domain: 'quiet.test', faviconStatus: 'found', faviconDetail: null })];
    await mountIdentityTab();

    const faviconCell = mounted.all('tbody td')[2]!;
    await hover(faviconCell.querySelector('span')! as HTMLElement);
    expect(tooltipText()).not.toContain('did not answer');
    await unhover(faviconCell.querySelector('span')! as HTMLElement);
  });

  it('still refreshes and forgets the domain by name', async () => {
    // The listing is also the only way to re-run or drop a cached lookup.
    await mountIdentityTab();

    fire(mounted.byLabel('Refresh deeperlearning.producthunt.com'), 'click');
    await settle();
    await settle();
    expect(calls.refresh).toEqual(['deeperlearning.producthunt.com']);

    fire(mounted.byLabel('Forget deeperlearning.producthunt.com'), 'click');
    await settle();
    await settle();
    expect(calls.forget).toEqual(['deeperlearning.producthunt.com']);
  });
});
