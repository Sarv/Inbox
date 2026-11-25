import { describe, expect, it } from 'vitest';

import { accountIdFor } from '../../../src/utils/id';
import {
  accountLogLabel,
  categoryLogLabel,
  folderLogLabel,
  labelLogLabel,
  redactAccountIds,
} from '../../../src/utils/log-labels';

const OWNER_ID = accountIdFor('ramesh.sentinel@example.com', 'imap.example.com');

describe('accountLogLabel', () => {
  // Regression: an account id written as is spells out the owner's address on every line.
  it('hides the address an account id is built from', () => {
    const label = accountLogLabel(OWNER_ID);
    expect(label).toMatch(/^acct#[0-9a-f]{8}$/);
    expect(label).not.toContain('sentinel');
    expect(label).not.toContain('example');
  });

  // Regression: two lines about one account stop reading as the same account (grep breaks).
  it('labels the same id the same way every time, and different ids differently', () => {
    expect(accountLogLabel(OWNER_ID)).toBe(accountLogLabel(OWNER_ID));
    expect(accountLogLabel(OWNER_ID)).not.toBe(accountLogLabel(accountIdFor('ramesh.sentinel@example.com', 'imap.gmail.com')));
  });

  // Regression: a missing id throws inside a catch, or prints "undefined" as if it were an id.
  it('says none for a missing or non-string id', () => {
    expect(accountLogLabel(undefined)).toBe('acct#none');
    expect(accountLogLabel(null)).toBe('acct#none');
    expect(accountLogLabel('')).toBe('acct#none');
    expect(accountLogLabel(42)).toBe('acct#none');
    // A caller where no id means "the active account" says so instead.
    expect(accountLogLabel(undefined, 'active')).toBe('active');
    expect(accountLogLabel(OWNER_ID, 'active')).toBe(accountLogLabel(OWNER_ID));
  });
});

describe('redactAccountIds', () => {
  // Regression: the release backstop misses an id a call site wrote without labelling it.
  it('replaces every account id in a line with its label', () => {
    const second = accountIdFor('other.person@example.org', 'mail.example.org');
    const line = `[Backfill] skipping ${OWNER_ID} — churning; next ${second}: ok (db sarvinbox-${OWNER_ID}.db)`;
    const out = redactAccountIds(line);
    expect(out).not.toContain('sentinel');
    expect(out).not.toContain('other-person');
    expect(out).toContain(accountLogLabel(OWNER_ID));
    expect(out).toContain(accountLogLabel(second));
    expect(out).toContain('[Backfill] skipping ');
  });

  // Regression: the backstop and a labelled call site disagree, so one account reads as two.
  it('gives a delimited id the same label the call site would', () => {
    expect(redactAccountIds(`acct=${OWNER_ID}, ok`)).toBe(`acct=${accountLogLabel(OWNER_ID)}, ok`);
  });

  // Regression: running the backstop over an already-labelled line mangles it.
  it('is idempotent and leaves text without ids alone', () => {
    const once = redactAccountIds(`for ${OWNER_ID}`);
    expect(redactAccountIds(once)).toBe(once);
    expect(redactAccountIds('nothing to see: account 3 of 4')).toBe('nothing to see: account 3 of 4');
  });

  // Regression: a hostile or huge line stalls the main thread inside the logger.
  it('stays linear on a long run of id characters', () => {
    const huge = `acct-${'a-'.repeat(200_000)}`;
    const started = performance.now();
    const out = redactAccountIds(huge);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(out).toMatch(/^acct#[0-9a-f]{8}$/);
  });
});

describe('folderLogLabel', () => {
  // Regression: a user-named folder (a client's or person's name) reaches app.log.
  it('hides a folder the user named', () => {
    for (const path of ['Clients/Acme Sentinel', 'INBOX/Acme Sentinel', 'INBOX.Acme Sentinel', '[Gmail]/Acme Sentinel', 'Ramesh']) {
      const label = folderLogLabel(path);
      expect(label).toMatch(/^folder#[0-9a-f]{8}$/);
      expect(label).not.toContain('Acme');
    }
  });

  // Regression: system folders turn into hashes and every sync line becomes unreadable.
  it('keeps system folders and the app\'s own view ids as written', () => {
    for (const path of ['INBOX', 'Inbox', 'Sent Items', 'Junk E-mail', '[Gmail]/All Mail', '[Gmail]/Sent Mail', '[Google Mail]/Bin', 'INBOX.Sent', 'INBOX/Drafts', 'Deleted Items', 'virtual-starred', 'folder-0123456789abcdef', 'section:inbox']) {
      expect(folderLogLabel(path)).toBe(path);
    }
  });

  // Regression: a long name that happens to start like a system folder is written whole.
  it('labels anything over 64 characters, and missing paths as none', () => {
    expect(folderLogLabel(`virtual-${'a'.repeat(70)}`)).toMatch(/^folder#/);
    expect(folderLogLabel(undefined)).toBe('folder#none');
    expect(folderLogLabel('')).toBe('folder#none');
  });

  // Regression: two lines about one folder no longer match.
  it('is stable per path', () => {
    expect(folderLogLabel('Clients/Acme')).toBe(folderLogLabel('Clients/Acme'));
    expect(folderLogLabel('Clients/Acme')).not.toBe(folderLogLabel('Clients/Acme2'));
  });
});

describe('labelLogLabel / categoryLogLabel', () => {
  // Regression: a Gmail label or custom keyword the user typed reaches app.log.
  it('hides a user-created label name', () => {
    expect(labelLogLabel('Tax 2026 — Ramesh')).toMatch(/^label#[0-9a-f]{8}$/);
    expect(labelLogLabel(undefined)).toBe('label#none');
  });

  // Regression: a custom AI category's name (built from what the user typed) reaches app.log,
  // or a built-in one turns into a hash nobody can read.
  it('keeps built-in category slugs and hides the user\'s own', () => {
    expect(categoryLogLabel('newsletters', true)).toBe('newsletters');
    expect(categoryLogLabel('acme-invoices', false)).toMatch(/^category#[0-9a-f]{8}$/);
    const builtIn = new Set(['newsletters', 'spam']);
    expect(categoryLogLabel('spam', builtIn)).toBe('spam');
    expect(categoryLogLabel('acme-invoices', builtIn)).toMatch(/^category#/);
    expect(categoryLogLabel('', builtIn)).toBe('category#none');
  });
});
