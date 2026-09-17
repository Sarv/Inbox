import { describe, expect, it } from 'vitest';

import { SQLiteStorage } from '../../src/sqlite-storage';
import { newMigratedDb } from '../../src/test-support/test-db';

/**
 * The user's trust/block rules for deceptive-looking links (migration v85).
 *
 * What this protects: a rule is the user saying "I have looked at this pair
 * and I vouch for it" (or the reverse). Losing one silently means the warning
 * comes back and the user learns to ignore warnings; keeping a stale one means
 * a link they later blocked stays trusted. Both are quiet failures, which is
 * why the storage contract is pinned here rather than only exercised through
 * the UI.
 */
const table = () => {
  const db = newMigratedDb();
  return db;
};

describe('link_domain_rules (v85)', () => {
  it('exists after migration with the sender-scoped unique key', () => {
    const db = table();
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'link_domain_rules'`).get() as { sql: string }).sql;
    expect(sql).toMatch(/UNIQUE\(sender_domain, shown_domain, actual_domain\)/);
    expect(sql).toMatch(/CHECK\(verdict IN \('trust', 'block'\)\)/);
  });

  // THE contract: re-recording the same triple is a change of mind, not a
  // second row. Trusting a pair you had blocked must flip it, not fail on the
  // unique key and leave the block in place.
  it('upserts: recording the same pair again replaces the verdict', () => {
    const db = table();
    const ins = db.prepare(
      `INSERT INTO link_domain_rules (sender_domain, shown_domain, actual_domain, verdict) VALUES (?, ?, ?, ?)
       ON CONFLICT(sender_domain, shown_domain, actual_domain)
       DO UPDATE SET verdict = excluded.verdict, created_at = unixepoch()`,
    );
    ins.run('shop.com', 'shop.com', 'mailer.io', 'block');
    ins.run('shop.com', 'shop.com', 'mailer.io', 'trust');

    const rows = db.prepare(`SELECT verdict FROM link_domain_rules`).all() as Array<{ verdict: string }>;
    expect(rows).toEqual([{ verdict: 'trust' }]);
  });

  // Scoped to the sender: the same redirect from a different sender is a
  // different rule, so two senders can hold opposite verdicts on one pair.
  it('keeps the same pair separate per sender', () => {
    const db = table();
    const ins = db.prepare(`INSERT INTO link_domain_rules (sender_domain, shown_domain, actual_domain, verdict) VALUES (?, ?, ?, ?)`);
    ins.run('shop.com', 'shop.com', 'mailer.io', 'trust');
    ins.run('other.com', 'shop.com', 'mailer.io', 'block');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM link_domain_rules`).get() as { n: number }).n).toBe(2);
  });

  it('rejects a verdict that is neither trust nor block', () => {
    const db = table();
    expect(() =>
      db.prepare(`INSERT INTO link_domain_rules (sender_domain, shown_domain, actual_domain, verdict) VALUES ('a','b','c','maybe')`).run(),
    ).toThrow(/CHECK constraint/);
  });
});

describe('SQLiteStorage link-rule methods', () => {
  // The storage class wraps the SQL above; these pin the normalisation and
  // the read shape the renderer cache depends on.
  const storage = () => {
    const db = newMigratedDb();
    const s = Object.create(SQLiteStorage.prototype) as SQLiteStorage & { db: unknown; ensureInitialized: () => void };
    (s as unknown as { db: unknown }).db = db;
    (s as unknown as { ensureInitialized: () => void }).ensureInitialized = () => {};
    return s;
  };

  it('lower-cases and trims domains on write so rule keys match the assessor', async () => {
    const s = storage();
    await s.addLinkDomainRule({ senderDomain: ' Shop.COM ', shownDomain: 'Shop.com', actualDomain: 'MAILER.io', verdict: 'trust' });
    const [r] = await s.listLinkDomainRules();
    expect(r).toMatchObject({ senderDomain: 'shop.com', shownDomain: 'shop.com', actualDomain: 'mailer.io', verdict: 'trust' });
  });

  // A rule with no shown or actual domain describes nothing; storing it would
  // be a row that can never match and never be seen.
  it('ignores a rule missing the shown or actual domain', async () => {
    const s = storage();
    await s.addLinkDomainRule({ senderDomain: 'a.com', shownDomain: '', actualDomain: 'b.com', verdict: 'trust' });
    await s.addLinkDomainRule({ senderDomain: 'a.com', shownDomain: 'b.com', actualDomain: '  ', verdict: 'trust' });
    expect(await s.listLinkDomainRules()).toEqual([]);
  });

  it('removes by id and leaves the others', async () => {
    const s = storage();
    await s.addLinkDomainRule({ senderDomain: 'a.com', shownDomain: 'x.com', actualDomain: 'y.com', verdict: 'trust' });
    await s.addLinkDomainRule({ senderDomain: 'a.com', shownDomain: 'p.com', actualDomain: 'q.com', verdict: 'block' });
    const before = await s.listLinkDomainRules();
    await s.removeLinkDomainRule(before.find((r) => r.verdict === 'block')!.id);
    const after = await s.listLinkDomainRules();
    expect(after.map((r) => r.verdict)).toEqual(['trust']);
  });

  it('revokes a sender’s remote-image allowance', async () => {
    const s = storage();
    await s.allowSenderImages('News@Shop.com');
    expect(await s.getImageAllowedSenders()).toEqual(['news@shop.com']);
    await s.disallowSenderImages('news@shop.com');
    expect(await s.getImageAllowedSenders()).toEqual([]);
  });
});
