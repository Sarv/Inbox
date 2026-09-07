import { describe, it, expect } from 'vitest';

import { isNoReplyAddress, isRoleAddress } from '../../../src/utils/role-address';

// These two predicates decide whether a mailbox is treated as a PERSON. Getting
// them wrong is user-visible and hard to undo: a false positive strips a real
// human of their contact record (no person_id, no enrichment), while a false
// negative lets no-reply@ get merged with other contacts by the shared company
// phone number scraped out of a transactional footer.

describe('isRoleAddress — no-reply / machine tier', () => {
  it('detects the common machine mailboxes', () => {
    for (const local of [
      'noreply',
      'no-reply',
      'donotreply',
      'do-not-reply',
      'notifications',
      'alerts',
      'mailer-daemon',
      'postmaster',
      'bounces',
      'invoices',
      'orders',
      'newsletter',
      'unsubscribe',
      'webmaster',
    ]) {
      expect(isRoleAddress(`${local}@acmecorp.com`)).toBe(true);
    }
  });
});

describe('isRoleAddress — human-staffed role tier', () => {
  it('detects the common shared/company mailboxes', () => {
    for (const local of [
      'info',
      'support',
      'helpdesk',
      'sales',
      'billing',
      'accounts',
      'hr',
      'careers',
      'admin',
      'legal',
      'security',
      'office',
    ]) {
      expect(isRoleAddress(`${local}@acmecorp.com`)).toBe(true);
    }
  });
});

describe('isRoleAddress — real humans must NOT be caught', () => {
  // The patterns are anchored precisely so a person whose name merely STARTS with
  // a role word keeps their contact record. This is the anchoring regression.
  it('does not match a human name that merely starts with a role word', () => {
    expect(isRoleAddress('careen@acmecorp.com')).toBe(false);   // vs careers
    expect(isRoleAddress('newsome@acmecorp.com')).toBe(false);  // vs news
    expect(isRoleAddress('information@acmecorp.com')).toBe(false); // vs info
    expect(isRoleAddress('salesman@acmecorp.com')).toBe(false); // vs sales
    expect(isRoleAddress('helpful@acmecorp.com')).toBe(false);  // vs help
    expect(isRoleAddress('rootbeer@acmecorp.com')).toBe(false); // vs root
  });

  it('does not match ordinary personal addresses', () => {
    expect(isRoleAddress('advik.d@sarv.com')).toBe(false);
    expect(isRoleAddress('j.smith@acmecorp.com')).toBe(false);
  });
});

describe('isRoleAddress — separators and normalization', () => {
  // Real senders decorate the local part: support+ticket123@, hr.india@,
  // noreply-billing@. The role word followed by . - _ + must still match.
  it('matches when the role word is followed by a . - _ or + separator', () => {
    expect(isRoleAddress('support+ticket123@acmecorp.com')).toBe(true);
    expect(isRoleAddress('hr.india@acmecorp.com')).toBe(true);
    expect(isRoleAddress('noreply-billing@acmecorp.com')).toBe(true);
    expect(isRoleAddress('alerts_prod@acmecorp.com')).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isRoleAddress('NoReply@AcmeCorp.com')).toBe(true);
    expect(isRoleAddress('SUPPORT@acmecorp.com')).toBe(true);
    expect(isRoleAddress('  info@acmecorp.com  ')).toBe(true);
  });

  it('looks only at the local part, not the domain', () => {
    // "support" in the DOMAIN must not make a human look like a role mailbox.
    expect(isRoleAddress('john@support.acmecorp.com')).toBe(false);
  });

  it('is false for missing / empty / local-part-less input', () => {
    expect(isRoleAddress(null)).toBe(false);
    expect(isRoleAddress(undefined)).toBe(false);
    expect(isRoleAddress('')).toBe(false);
    expect(isRoleAddress('@acmecorp.com')).toBe(false);
    expect(isRoleAddress('   ')).toBe(false);
  });
});

describe('isNoReplyAddress', () => {
  // Enrichment uses THIS, not isRoleAddress: a human-staffed role mailbox still
  // carries a real signature worth mining, a machine mailbox never does.
  it('is true only for the machine tier', () => {
    expect(isNoReplyAddress('noreply@acmecorp.com')).toBe(true);
    expect(isNoReplyAddress('mailer-daemon@acmecorp.com')).toBe(true);
    expect(isNoReplyAddress('invoices@acmecorp.com')).toBe(true);
  });

  it('is FALSE for human-staffed role mailboxes even though they are role addresses', () => {
    for (const local of ['hr', 'sales', 'support', 'careers', 'info', 'billing']) {
      const address = `${local}@acmecorp.com`;
      expect(isNoReplyAddress(address)).toBe(false); // signature still worth mining
      expect(isRoleAddress(address)).toBe(true);     // but never a person
    }
  });

  it('is false for humans and for missing input', () => {
    expect(isNoReplyAddress('advik.d@sarv.com')).toBe(false);
    expect(isNoReplyAddress('careen@acmecorp.com')).toBe(false);
    expect(isNoReplyAddress(null)).toBe(false);
    expect(isNoReplyAddress('')).toBe(false);
    expect(isNoReplyAddress('@acmecorp.com')).toBe(false);
  });

  // The two tiers must stay a strict subset relationship: everything in the
  // machine tier is also a role address.
  it('implies isRoleAddress (machine tier is a subset of the role union)', () => {
    for (const local of ['noreply', 'postmaster', 'orders', 'digest', 'system']) {
      expect(isRoleAddress(`${local}@acmecorp.com`)).toBe(true);
    }
  });
});
