import { describe, it, expect } from 'vitest';

import { contactNameForAddress, isNoReplyAddress, isRoleAddress } from '../../../src/utils/role-address';

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

describe('machine mailboxes that carry the marker as a suffix', () => {
  // Regression: the detector only matched the marker as a PREFIX, so the shapes
  // the big providers actually generate read as people. Notification mail puts
  // the acting HUMAN in the From display name, so the directory filled with a
  // real colleague's name attached to a robot's address — searching for that
  // person returned mostly robots.
  it.each([
    'drive-shares-dm-noreply@google.com',
    'drive-shares-noreply@google.com',
    'pullrequests-reply@bitbucket.org',
    'comments-noreply@docs.google.com',
    'jira-notifications@atlassian.net',
    'build_alerts@ci.example.com',
    'list-bounces@mailman.example.org',
  ])('treats %s as a machine mailbox', (address) => {
    expect(isNoReplyAddress(address)).toBe(true);
    expect(isRoleAddress(address)).toBe(true);
  });

  // The suffix arm must need a separator before the marker, or it starts
  // eating people. These are the names it would wrongly swallow if the
  // boundary were dropped.
  it.each([
    'bhupesh@sarv.com',
    'mahima.k@sarv.com',
    'devendra.k@sarv.com',
    'hnotify@sarv.com',
    'jreply@example.com',
    'daniel.mailery@example.com',
  ])('leaves %s alone', (address) => {
    expect(isNoReplyAddress(address)).toBe(false);
  });

  // Human-staffed role mailboxes stay OUT of the no-reply tier: a person mans
  // them and signs off, so their signature is still worth mining.
  it('keeps human-staffed role mailboxes out of the machine tier', () => {
    expect(isNoReplyAddress('hr@sarv.com')).toBe(false);
    expect(isNoReplyAddress('sales@sarv.com')).toBe(false);
    expect(isRoleAddress('hr@sarv.com')).toBe(true);
  });
});

describe('contactNameForAddress', () => {
  // Regression: a no-reply mailbox is never held by a person, so it must never
  // wear one's name. Atlassian sends "Bhupesh Chugh <notifications@atlassian.net>";
  // taken at face value that mints a contact carrying a colleague's name on an
  // address that is not his.
  it('names a machine mailbox after the service, not the human in the From', () => {
    expect(contactNameForAddress('notifications@atlassian.net', 'Bhupesh Chugh')).toBe('atlassian.net');
    expect(contactNameForAddress('pullrequests-reply@bitbucket.org', 'Devendra Rathore')).toBe('bitbucket.org');
    expect(contactNameForAddress('drive-shares-dm-noreply@google.com', 'Bhupesh Chugh (via Google Docs)'))
      .toBe('google.com');
  });

  // A real person's display name must survive untouched — this helper sits on
  // the path EVERY contact is created through.
  it('leaves a real person’s name alone', () => {
    expect(contactNameForAddress('bhupesh@sarv.com', 'Bhupesh Chugh')).toBe('Bhupesh Chugh');
    expect(contactNameForAddress('hr@sarv.com', 'Priya Nair')).toBe('Priya Nair');
  });

  // Missing pieces must yield null rather than '' or 'undefined': upsert only
  // fills a name when the row has none, so a junk value written once sticks.
  it('returns null when there is no name to give', () => {
    expect(contactNameForAddress('bhupesh@sarv.com', null)).toBeNull();
    expect(contactNameForAddress('bhupesh@sarv.com', '')).toBeNull();
    // A machine address with no domain left to name it after.
    expect(contactNameForAddress('noreply@', 'Someone')).toBeNull();
    // An absent address is not a machine mailbox, so the name stands.
    expect(contactNameForAddress(null, 'Someone')).toBe('Someone');
  });

  it('drops a www. prefix so the service reads as one name', () => {
    expect(contactNameForAddress('noreply@www.example.com', 'A Person')).toBe('example.com');
  });
});
