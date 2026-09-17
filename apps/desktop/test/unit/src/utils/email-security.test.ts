// @vitest-environment happy-dom
// linkMismatches() parses the body with DOMParser, so this file needs a DOM.
import { describe, expect, it } from 'vitest';

import {
  assessEmailSecurity,
  firstFlaggedEmailId,
  linkRuleKey,
  parseAuthStatus,
  worstLevel,
  type LinkRuleSets,
} from '../../../../src/utils/email-security';

/**
 * The security level shown beside every sender.
 *
 * What this protects: a shield colour is a promise. Green on a forged bank
 * statement, or red on the user's own accountant, is worse than no shield at
 * all — so each level boundary is pinned to the evidence that earns it, and
 * the tests below are the contract the tooltip, banner and Security page all
 * share through this one function.
 */
const auth = (spf: string, dkim: string, dmarc: string, overall: string) =>
  JSON.stringify({ spf, dkim, dmarc, overall });

const PASS = auth('pass', 'pass', 'pass', 'pass');
const FAIL = auth('fail', 'fail', 'fail', 'fail');

const rules = (trusted: string[] = [], blocked: string[] = []): LinkRuleSets => ({
  trusted: new Set(trusted),
  blocked: new Set(blocked),
});

describe('assessEmailSecurity — the level', () => {
  // THE top level: authenticated AND nothing points away from the sender.
  it('is verified when auth passes and every link stays on the sender domain', () => {
    const a = assessEmailSecurity({
      fromName: 'Sarv', fromAddress: 'billing@sarv.com', authStatus: PASS,
      html: '<a href="https://app.sarv.com/invoice">View invoice</a>',
    });
    expect(a.level).toBe('verified');
  });

  // A newsletter that passes DMARC but links to its CDN is REAL but not
  // "everything here is the sender" — the distinction the two green-ish
  // levels exist to make.
  it('is authenticated, not verified, when auth passes but links go elsewhere', () => {
    const a = assessEmailSecurity({
      fromName: 'Shop', fromAddress: 'news@shop.com', authStatus: PASS,
      html: '<a href="https://cdn.tracker.io/x">Shop now</a>',
    });
    expect(a.level).toBe('authenticated');
  });

  // Most small senders publish no DMARC. That is "cannot confirm", which is
  // not the same thing as "suspicious", and must never be amber.
  it('is unverified when no auth verdict exists and nothing is wrong', () => {
    const a = assessEmailSecurity({ fromName: 'Ravi', fromAddress: 'ravi@example.org', html: '<p>hi</p>' });
    expect(a.level).toBe('unverified');
    expect(a.checks.filter((c) => c.status === 'unknown')).toHaveLength(3);
  });

  // The classic tell: text names one domain, href goes to another.
  it('is caution when a link says one domain and points to another', () => {
    const a = assessEmailSecurity({
      fromName: 'Ravi', fromAddress: 'ravi@example.org',
      html: '<a href="https://evil.ru/login">paypal.com</a>',
    });
    expect(a.level).toBe('caution');
    expect(a.untrustedLinks).toEqual([{ shown: 'paypal.com', actual: 'evil.ru' }]);
  });

  it('is caution on SPF softfail even with a clean body', () => {
    const a = assessEmailSecurity({
      fromName: 'X', fromAddress: 'x@example.org', html: '<p>hi</p>',
      authStatus: auth('softfail', 'none', 'none', 'none'),
    });
    expect(a.level).toBe('caution');
  });

  // THE authoritative signal. A failing DMARC is not a heuristic — the domain
  // owner said "reject". Nothing in the body can soften it.
  it('is danger when authentication fails, whatever the body says', () => {
    const a = assessEmailSecurity({
      fromName: 'Bank', fromAddress: 'alerts@bank.com', authStatus: FAIL,
      html: '<a href="https://bank.com/x">bank.com</a>',
    });
    expect(a.level).toBe('danger');
  });

  it('is danger when the display name impersonates another domain', () => {
    const a = assessEmailSecurity({
      fromName: 'PayPal <service@paypal.com>', fromAddress: 'x@evil.ru', html: '<p>hi</p>',
    });
    expect(a.level).toBe('danger');
    expect(a.checks.find((c) => c.id === 'sender')?.status).toBe('fail');
  });

  // Auth pass must NOT launder a deceptive link: a compromised legitimate
  // account passes SPF/DKIM/DMARC perfectly and phishes anyway.
  it('does not let a passing auth hide a deceptive link', () => {
    const a = assessEmailSecurity({
      fromName: 'Ravi', fromAddress: 'ravi@example.org', authStatus: PASS,
      html: '<a href="https://evil.ru/login">paypal.com</a>',
    });
    expect(a.level).toBe('caution');
  });
});

describe('assessEmailSecurity — trust and block rules', () => {
  const html = '<a href="https://track.mailer.io/r/1">shop.com</a>';
  const key = linkRuleKey('shop.com', 'shop.com', 'mailer.io');

  // THE feature: a vetted pair stops being a warning — for this sender.
  it('a trusted pair no longer flags the message', () => {
    const a = assessEmailSecurity({
      fromName: 'Shop', fromAddress: 'news@shop.com', authStatus: PASS, html, rules: rules([key]),
    });
    expect(a.level).toBe('authenticated');
    expect(a.untrustedLinks).toEqual([]);
    expect(a.checks.find((c) => c.id === 'links')?.detail).toMatch(/1 pair you trust/);
  });

  // Scoped to the sender on purpose: the same redirect from a different
  // sender is a different question, and must still be flagged.
  it('a trust rule for one sender does not cover another sender', () => {
    const a = assessEmailSecurity({
      fromName: 'Other', fromAddress: 'news@other.com', html, rules: rules([key]),
    });
    expect(a.level).toBe('caution');
  });

  it('a blocked pair forces danger', () => {
    const a = assessEmailSecurity({
      fromName: 'Shop', fromAddress: 'news@shop.com', authStatus: PASS, html, rules: rules([], [key]),
    });
    expect(a.level).toBe('danger');
    expect(a.blockedLinks).toHaveLength(1);
  });

  it('keys are case-insensitive', () => {
    expect(linkRuleKey('Shop.COM', 'Shop.com', 'Mailer.IO')).toBe('shop.com|shop.com|mailer.io');
  });
});

describe('parseAuthStatus', () => {
  it('returns null for missing or unreadable input rather than throwing', () => {
    expect(parseAuthStatus(null)).toBeNull();
    expect(parseAuthStatus('')).toBeNull();
    expect(parseAuthStatus('not json')).toBeNull();
    expect(parseAuthStatus('"a string"')).toBeNull();
  });

  it('fills missing fields with unknown', () => {
    expect(parseAuthStatus('{"spf":"pass"}')).toEqual({ spf: 'pass', dkim: 'unknown', dmarc: 'unknown', overall: 'none' });
  });
});

describe('worstLevel', () => {
  it('escalates to the worst message in a set', () => {
    expect(worstLevel(['verified', 'unverified', 'caution'])).toBe('caution');
    expect(worstLevel(['authenticated', 'danger', 'verified'])).toBe('danger');
    expect(worstLevel([])).toBe('verified');
  });
});

describe('firstFlaggedEmailId — where the one thread banner goes', () => {
  const clean = (id: string, date: number) => ({ id, date, fromName: 'A', fromAddress: 'a@example.org', rawBody: '<p>ok</p>' });
  const spoof = (id: string, date: number) => ({ id, date, fromName: 'PayPal <s@paypal.com>', fromAddress: 'x@evil.ru', rawBody: '<p>x</p>' });

  // THE bug the ThreadList comment records: pinning the banner to the oldest
  // message hid a newly arrived spoof. It must land on the offending message.
  it('picks the first flagged message by date, not the first message', () => {
    expect(firstFlaggedEmailId([clean('a', 1), clean('b', 2), spoof('c', 3)])).toBe('c');
  });

  it('picks the earliest flagged when several are flagged', () => {
    expect(firstFlaggedEmailId([spoof('late', 9), clean('a', 1), spoof('early', 2)])).toBe('early');
  });

  it('is null when nothing in the thread warrants a banner', () => {
    expect(firstFlaggedEmailId([clean('a', 1), clean('b', 2)])).toBeNull();
  });

  it('does not mutate the caller’s array order', () => {
    const arr = [clean('b', 2), clean('a', 1)];
    firstFlaggedEmailId(arr);
    expect(arr.map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('assessEmailSecurity — DMARC is the authoritative verdict', () => {
  // THE false positive, from the live mailbox: Axis Bank, IHG and CII mail with
  // spf=pass dkim=fail dmarc=pass went RED. A forwarder broke one signature;
  // DMARC still aligned. Red on a bank statement teaches the reader to ignore red.
  it('does not go red when DKIM fails but DMARC passes', () => {
    const a = assessEmailSecurity({
      fromName: 'Axis Bank', fromAddress: 'info@alerts.axisbankmail.bank.in',
      authStatus: auth('pass', 'fail', 'pass', 'fail'),
      html: '<p>statement</p><a href="https://cdn.axisbankmail.net/s">View statement</a>',
    });
    expect(a.level).toBe('authenticated');
    expect(a.checks.find((c) => c.id === 'dkim')?.status).toBe('warn'); // still visible
  });

  // Also from the live list: spf+dkim pass but DMARC FAIL means the domain that
  // authenticated is not the domain in From — alignment failed. That IS a spoof
  // signal, whatever the components say individually.
  it('goes red on DMARC fail even when SPF and DKIM both pass', () => {
    const a = assessEmailSecurity({
      fromName: 'Astra', fromAddress: 'ujwal@getastra.io',
      authStatus: auth('pass', 'pass', 'fail', 'fail'), html: '<p>pentest</p>',
    });
    expect(a.level).toBe('danger');
  });

  // The most valuable catch in the whole list: mail claiming to be from the
  // reader's OWN address, failing DMARC. Textbook spoof of your own domain.
  it('goes red on a spoof of the user’s own address', () => {
    const a = assessEmailSecurity({
      fromName: 'Ramesh', fromAddress: 'rc@sarv.com',
      authStatus: auth('softfail', 'none', 'fail', 'fail'), html: '<p>Disputed transaction is available</p>',
    });
    expect(a.level).toBe('danger');
  });

  // No DMARC verdict and one input failed: unsettled, not condemned.
  it('is caution, not danger, when one input fails and DMARC recorded nothing', () => {
    const a = assessEmailSecurity({
      fromName: 'Cloud', fromAddress: 'ashish@cloudsxpert.com',
      authStatus: auth('pass', 'fail', 'none', 'fail'), html: '<p>servers</p>',
    });
    expect(a.level).toBe('caution');
  });

  // No DMARC verdict and BOTH inputs failed: nothing vouches for the sender.
  it('is danger when both inputs fail and DMARC recorded nothing', () => {
    const a = assessEmailSecurity({
      fromName: 'X', fromAddress: 'x@example.org',
      authStatus: auth('fail', 'fail', 'none', 'fail'), html: '<p>hi</p>',
    });
    expect(a.level).toBe('danger');
  });

  // Without a DMARC verdict, SPF and DKIM both passing is the next-best proof.
  it('is authenticated when SPF and DKIM pass with no DMARC verdict', () => {
    const a = assessEmailSecurity({
      fromName: 'Ops', fromAddress: 'ops@example.org',
      authStatus: auth('pass', 'pass', 'none', 'pass'), html: '<a href="https://cdn.x.io/a">go</a>',
    });
    expect(a.level).toBe('authenticated');
  });
});
