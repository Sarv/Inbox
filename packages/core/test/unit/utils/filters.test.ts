import { describe, it, expect } from 'vitest';

import type { FilterAction, FilterCondition, FilterRule } from '../../../src/types/filters';
import type { EmailRecord } from '../../../src/types/models';
import { collectFilterActions, computeFilterActionResult, emailMatchesRule } from '../../../src/utils/filters';

// Filter rules run on EVERY ingested message and can mark read / move / delete.
// A false positive silently files away real mail, so each operator, the AND/OR
// combination, priority ordering and stopProcessing are pinned here.

const makeEmail = (overrides: Partial<EmailRecord> = {}): EmailRecord =>
  ({
    id: 'e1',
    folderId: 'f-inbox',
    tags: '|INBOX|',
    subject: 'Quarterly Invoice #42',
    fromAddress: 'billing@acmecorp.com',
    fromName: 'Acme Billing',
    toAddress: 'advik.d@sarv.com',
    ccAddress: 'boss@sarv.com',
    cleanBody: 'Please find the invoice attached.',
    ...overrides,
  }) as unknown as EmailRecord;

const rule = (overrides: Partial<FilterRule> = {}): FilterRule =>
  ({
    id: 'r1',
    name: 'rule',
    enabled: true,
    priority: 0,
    matchType: 'all',
    conditions: [],
    actions: [],
    stopProcessing: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }) as FilterRule;

const cond = (
  field: FilterCondition['field'],
  operator: FilterCondition['operator'],
  value: string,
): FilterCondition => ({ field, operator, value });

const matches = (email: EmailRecord, condition: FilterCondition) =>
  emailMatchesRule(email, rule({ conditions: [condition] }));

describe('condition fields', () => {
  // `from` deliberately searches address AND display name, so "Acme" matches a
  // sender whose address gives no hint of the company.
  it('from searches both the address and the display name', () => {
    const email = makeEmail();
    expect(matches(email, cond('from', 'contains', 'acmecorp.com'))).toBe(true);
    expect(matches(email, cond('from', 'contains', 'Acme Billing'))).toBe(true);
    expect(matches(email, cond('from', 'contains', 'nobody'))).toBe(false);
  });

  it('to, cc, subject and body read their own field only', () => {
    const email = makeEmail();
    expect(matches(email, cond('to', 'contains', 'advik.d@sarv.com'))).toBe(true);
    expect(matches(email, cond('cc', 'contains', 'boss@sarv.com'))).toBe(true);
    expect(matches(email, cond('subject', 'contains', 'invoice'))).toBe(true);
    expect(matches(email, cond('body', 'contains', 'attached'))).toBe(true);
    // The subject text must not be reachable through the `to` field.
    expect(matches(email, cond('to', 'contains', 'invoice'))).toBe(false);
  });

  // `domain` is split on the LAST '@' so a local-part containing '@' (quoted
  // form) can't be used to spoof a trusted domain.
  it('domain takes everything after the LAST @ of the sender address', () => {
    expect(matches(makeEmail(), cond('domain', 'equals', 'acmecorp.com'))).toBe(true);
    const spoof = makeEmail({ fromAddress: 'trusted@bank.com@evil.example' });
    expect(matches(spoof, cond('domain', 'equals', 'evil.example'))).toBe(true);
    expect(matches(spoof, cond('domain', 'equals', 'bank.com'))).toBe(false);
  });

  it('domain is empty (never matches) when the address has no @', () => {
    const email = makeEmail({ fromAddress: 'mailer-daemon' });
    expect(matches(email, cond('domain', 'contains', 'mailer'))).toBe(false);
  });

  // A rule persisted by an older/newer app version may carry a field we don't
  // know; it must not throw and must not match.
  it('an unknown field never matches instead of throwing', () => {
    const bogus = { field: 'headers', operator: 'contains', value: 'x' } as unknown as FilterCondition;
    expect(matches(makeEmail(), bogus)).toBe(false);
  });

  // Nullable columns are the common real-world case (no subject, no cc).
  it('treats a missing/null field as empty text', () => {
    const bare = makeEmail({ subject: null, ccAddress: null, cleanBody: '', fromName: null });
    expect(matches(bare, cond('subject', 'contains', 'invoice'))).toBe(false);
    expect(matches(bare, cond('cc', 'contains', 'boss'))).toBe(false);
    expect(matches(bare, cond('body', 'contains', 'invoice'))).toBe(false);
    // ...and the sender address alone still works with no display name.
    expect(matches(bare, cond('from', 'contains', 'billing@acmecorp.com'))).toBe(true);
  });

  // LIST-shaped rows omit columns entirely (undefined, not null) — e.g. cleanBody
  // is only a snippet and a malformed message can have no From at all. A rule must
  // never throw on a partially-populated row mid-ingest.
  it('treats an entirely absent field as empty text (undefined, not just null)', () => {
    const partial = {
      id: 'e2',
      folderId: 'f-inbox',
      tags: '|INBOX|',
      subject: 'no sender',
    } as unknown as EmailRecord;

    expect(matches(partial, cond('from', 'contains', 'acme'))).toBe(false);
    expect(matches(partial, cond('to', 'contains', 'advik'))).toBe(false);
    expect(matches(partial, cond('body', 'contains', 'invoice'))).toBe(false);
    expect(matches(partial, cond('domain', 'contains', 'acme'))).toBe(false);
    // The one field it does have still evaluates normally.
    expect(matches(partial, cond('subject', 'equals', 'no sender'))).toBe(true);
  });
});

describe('condition operators', () => {
  it('contains / notContains are inverses of each other', () => {
    const email = makeEmail();
    expect(matches(email, cond('subject', 'contains', 'invoice'))).toBe(true);
    expect(matches(email, cond('subject', 'notContains', 'invoice'))).toBe(false);
    expect(matches(email, cond('subject', 'notContains', 'receipt'))).toBe(true);
  });

  it('equals compares the whole (trimmed) field, not a substring', () => {
    const email = makeEmail({ subject: '  Quarterly Invoice #42  ' });
    expect(matches(email, cond('subject', 'equals', 'Quarterly Invoice #42'))).toBe(true);
    expect(matches(email, cond('subject', 'equals', 'Quarterly'))).toBe(false);
  });

  it('startsWith / endsWith anchor to the field edges, ignoring surrounding space', () => {
    const email = makeEmail({ subject: '   [ALERT] disk full   ' });
    expect(matches(email, cond('subject', 'startsWith', '[ALERT]'))).toBe(true);
    expect(matches(email, cond('subject', 'startsWith', 'disk'))).toBe(false);
    expect(matches(email, cond('subject', 'endsWith', 'full'))).toBe(true);
    expect(matches(email, cond('subject', 'endsWith', '[ALERT]'))).toBe(false);
  });

  // Users type "Invoice"; servers send "INVOICE". Matching must be case-blind on
  // both the needle and the haystack.
  it('is case-insensitive on both sides, and trims the needle', () => {
    const email = makeEmail({ subject: 'URGENT: Invoice' });
    expect(matches(email, cond('subject', 'contains', 'urgent'))).toBe(true);
    expect(matches(email, cond('subject', 'contains', '  InVoIcE  '))).toBe(true);
    expect(matches(email, cond('from', 'contains', 'ACME BILLING'))).toBe(true);
  });

  // A half-finished rule (value left blank) must be inert. Critically this
  // includes notContains: naively, "not contains ''" is TRUE for every email,
  // which would apply the rule's actions to the entire mailbox.
  it('an empty value never matches — including notContains', () => {
    const email = makeEmail();
    expect(matches(email, cond('subject', 'contains', ''))).toBe(false);
    expect(matches(email, cond('subject', 'notContains', ''))).toBe(false);
    expect(matches(email, cond('subject', 'notContains', '   '))).toBe(false);
    expect(matches(email, cond('subject', 'equals', ''))).toBe(false);
    expect(matches(email, { field: 'subject', operator: 'contains' } as unknown as FilterCondition)).toBe(false);
  });

  it('an unknown operator never matches instead of throwing', () => {
    const bogus = { field: 'subject', operator: 'regex', value: 'inv.*' } as unknown as FilterCondition;
    expect(matches(makeEmail(), bogus)).toBe(false);
  });
});

describe('emailMatchesRule', () => {
  it('matchType "all" requires EVERY condition (AND)', () => {
    const email = makeEmail();
    const r = rule({
      matchType: 'all',
      conditions: [cond('subject', 'contains', 'invoice'), cond('domain', 'equals', 'acmecorp.com')],
    });
    expect(emailMatchesRule(email, r)).toBe(true);

    const rMissOne = rule({
      matchType: 'all',
      conditions: [cond('subject', 'contains', 'invoice'), cond('domain', 'equals', 'other.com')],
    });
    expect(emailMatchesRule(email, rMissOne)).toBe(false);
  });

  it('matchType "any" requires only one condition (OR)', () => {
    const email = makeEmail();
    const r = rule({
      matchType: 'any',
      conditions: [cond('subject', 'contains', 'nope'), cond('domain', 'equals', 'acmecorp.com')],
    });
    expect(emailMatchesRule(email, r)).toBe(true);

    const rMissAll = rule({
      matchType: 'any',
      conditions: [cond('subject', 'contains', 'nope'), cond('domain', 'equals', 'other.com')],
    });
    expect(emailMatchesRule(email, rMissAll)).toBe(false);
  });

  // A disabled rule must be completely inert — the user's off switch is the only
  // thing standing between them and an unwanted auto-delete.
  it('never matches a disabled rule', () => {
    const r = rule({ enabled: false, conditions: [cond('subject', 'contains', 'invoice')] });
    expect(emailMatchesRule(makeEmail(), r)).toBe(false);
  });

  // With zero conditions, `every()` would return TRUE and the rule would match
  // every message in the mailbox. It must be treated as "not configured".
  it('never matches a rule with no conditions (the match-everything trap)', () => {
    expect(emailMatchesRule(makeEmail(), rule({ matchType: 'all', conditions: [] }))).toBe(false);
    expect(emailMatchesRule(makeEmail(), rule({ matchType: 'any', conditions: [] }))).toBe(false);
  });
});

describe('collectFilterActions', () => {
  const star: FilterAction = { type: 'star' };
  const markRead: FilterAction = { type: 'markRead' };
  const label = (value: string): FilterAction => ({ type: 'applyLabel', value });

  const matching = (overrides: Partial<FilterRule>) =>
    rule({ conditions: [cond('subject', 'contains', 'invoice')], ...overrides });

  it('flattens the actions of every matching rule', () => {
    const actions = collectFilterActions(makeEmail(), [
      matching({ id: 'a', actions: [star] }),
      matching({ id: 'b', actions: [markRead] }),
    ]);
    expect(actions).toEqual([star, markRead]);
  });

  it('returns [] when nothing matches', () => {
    const actions = collectFilterActions(
      makeEmail(),
      [rule({ conditions: [cond('subject', 'contains', 'receipt')], actions: [star] })],
    );
    expect(actions).toEqual([]);
  });

  // Priority is the user's conflict resolver: "archive newsletters" must lose to
  // "never archive mail from my boss" when the latter is ranked higher.
  it('runs rules highest-priority first', () => {
    const actions = collectFilterActions(makeEmail(), [
      matching({ id: 'low', priority: 1, actions: [label('low')] }),
      matching({ id: 'high', priority: 9, actions: [label('high')] }),
      matching({ id: 'mid', priority: 5, actions: [label('mid')] }),
    ]);
    expect(actions.map((a) => a.value)).toEqual(['high', 'mid', 'low']);
  });

  // Equal priority must be stable and predictable, else the applied actions
  // change between runs for the same mailbox.
  it('breaks priority ties by creation order (oldest first)', () => {
    const actions = collectFilterActions(makeEmail(), [
      matching({ id: 'newer', priority: 5, createdAt: 2_000, actions: [label('newer')] }),
      matching({ id: 'older', priority: 5, createdAt: 1_000, actions: [label('older')] }),
    ]);
    expect(actions.map((a) => a.value)).toEqual(['older', 'newer']);
  });

  it('stops after a matching rule with stopProcessing (later rules never run)', () => {
    const actions = collectFilterActions(makeEmail(), [
      matching({ id: 'stopper', priority: 9, stopProcessing: true, actions: [label('stopper')] }),
      matching({ id: 'after', priority: 1, actions: [label('after')] }),
    ]);
    expect(actions.map((a) => a.value)).toEqual(['stopper']);
  });

  // stopProcessing on a NON-matching rule must not short-circuit the chain.
  it('does not stop on a non-matching rule that has stopProcessing set', () => {
    const actions = collectFilterActions(makeEmail(), [
      rule({
        id: 'stopper',
        priority: 9,
        stopProcessing: true,
        conditions: [cond('subject', 'contains', 'receipt')],
        actions: [label('stopper')],
      }),
      matching({ id: 'after', priority: 1, actions: [label('after')] }),
    ]);
    expect(actions.map((a) => a.value)).toEqual(['after']);
  });

  it('ignores disabled rules entirely', () => {
    const actions = collectFilterActions(makeEmail(), [
      matching({ id: 'off', enabled: false, priority: 9, stopProcessing: true, actions: [label('off')] }),
      matching({ id: 'on', priority: 1, actions: [label('on')] }),
    ]);
    expect(actions.map((a) => a.value)).toEqual(['on']);
  });

  it('returns [] for an empty rule list', () => {
    expect(collectFilterActions(makeEmail(), [])).toEqual([]);
  });
});

describe('computeFilterActionResult', () => {
  // A realistic folder list: `moveTo*` resolves through SPECIAL-USE first.
  const folders = [
    { id: 'f-inbox', path: 'INBOX', specialUse: '\\Inbox' },
    { id: 'f-spam', path: 'Spam', specialUse: '\\Junk' },
    { id: 'f-trash', path: 'Trash', specialUse: '\\Trash' },
    { id: 'f-archive', path: 'Archive', specialUse: '\\Archive' },
    { id: 'f-alpha', path: 'Projects/Alpha', specialUse: null },
  ];
  const inboxEmail = () => ({ tags: '|INBOX|', folderId: 'f-inbox' });

  it('markRead and star add their flag tags and report the change', () => {
    const res = computeFilterActionResult(inboxEmail(), [{ type: 'markRead' }, { type: 'star' }], folders);
    expect(res.tags).toBe('|INBOX|read|starred|');
    expect(res.folderId).toBe('f-inbox');
    expect(res.changed).toBe(true);
  });

  // `changed` gates the DB write; re-applying a rule to already-filtered mail
  // must not churn rows (or re-emit UI updates) forever.
  it('reports changed=false when the flag is already present', () => {
    const res = computeFilterActionResult({ tags: '|INBOX|read|', folderId: 'f-inbox' }, [{ type: 'markRead' }], folders);
    expect(res.tags).toBe('|INBOX|read|');
    expect(res.changed).toBe(false);
  });

  it('applyLabel adds the label tag, and is a no-op without a value', () => {
    expect(computeFilterActionResult(inboxEmail(), [{ type: 'applyLabel', value: 'Receipts' }], folders).tags)
      .toBe('|INBOX|Receipts|');
    const noValue = computeFilterActionResult(inboxEmail(), [{ type: 'applyLabel' }], folders);
    expect(noValue.tags).toBe('|INBOX|');
    expect(noValue.changed).toBe(false);
  });

  // A move must both re-point folderId AND swap the folder-path tag, because the
  // list views query by the `|path|` tag, not by folderId.
  it('moveToSpam / archive / delete swap the folder tag and folderId together', () => {
    const spam = computeFilterActionResult(inboxEmail(), [{ type: 'moveToSpam' }], folders);
    expect(spam).toEqual({ tags: '|Spam|', folderId: 'f-spam', changed: true });

    const archived = computeFilterActionResult(inboxEmail(), [{ type: 'archive' }], folders);
    expect(archived).toEqual({ tags: '|Archive|', folderId: 'f-archive', changed: true });

    const deleted = computeFilterActionResult(inboxEmail(), [{ type: 'delete' }], folders);
    expect(deleted).toEqual({ tags: '|Trash|', folderId: 'f-trash', changed: true });
  });

  it('preserves unrelated tags across a move', () => {
    const res = computeFilterActionResult({ tags: '|INBOX|read|Receipts|', folderId: 'f-inbox' }, [{ type: 'delete' }], folders);
    expect(res.tags).toBe('|read|Receipts|Trash|');
    expect(res.folderId).toBe('f-trash');
  });

  it('moveToFolder targets a folder by path', () => {
    const res = computeFilterActionResult(inboxEmail(), [{ type: 'moveToFolder', value: 'Projects/Alpha' }], folders);
    expect(res).toEqual({ tags: '|Projects/Alpha|', folderId: 'f-alpha', changed: true });
  });

  // A rule pointing at a folder the user has since deleted (or renamed) must not
  // strand the message in a folder that doesn't exist.
  it('is a no-op when the target folder cannot be resolved', () => {
    expect(computeFilterActionResult(inboxEmail(), [{ type: 'moveToFolder', value: 'Gone/Missing' }], folders))
      .toEqual({ tags: '|INBOX|', folderId: 'f-inbox', changed: false });
    expect(computeFilterActionResult(inboxEmail(), [{ type: 'moveToFolder' }], folders))
      .toEqual({ tags: '|INBOX|', folderId: 'f-inbox', changed: false });
    // No spam/trash/archive folder exists at all on this (minimal) account.
    const onlyInbox = [{ id: 'f-inbox', path: 'INBOX', specialUse: '\\Inbox' }];
    expect(computeFilterActionResult(inboxEmail(), [{ type: 'moveToSpam' }, { type: 'delete' }], onlyInbox))
      .toEqual({ tags: '|INBOX|', folderId: 'f-inbox', changed: false });
  });

  // Moving to where it already is must report changed=false so we don't enqueue
  // a pointless server MOVE.
  it('is a no-op when the message is already in the target folder', () => {
    const res = computeFilterActionResult({ tags: '|Spam|', folderId: 'f-spam' }, [{ type: 'moveToSpam' }], folders);
    expect(res).toEqual({ tags: '|Spam|', folderId: 'f-spam', changed: false });
  });

  it('handles a null/absent tags column and an unresolvable current folder', () => {
    const res = computeFilterActionResult({ tags: null, folderId: 'f-unknown' }, [{ type: 'moveToSpam' }], folders);
    expect(res).toEqual({ tags: '|Spam|', folderId: 'f-spam', changed: true });
  });

  it('ignores an unknown action type rather than throwing', () => {
    const res = computeFilterActionResult(
      inboxEmail(),
      [{ type: 'snooze' } as unknown as FilterAction, { type: 'star' }],
      folders,
    );
    expect(res.tags).toBe('|INBOX|starred|');
    expect(res.changed).toBe(true);
  });

  it('returns the email untouched for an empty action list', () => {
    expect(computeFilterActionResult(inboxEmail(), [], folders))
      .toEqual({ tags: '|INBOX|', folderId: 'f-inbox', changed: false });
  });
});
