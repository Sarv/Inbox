import { describe, expect, it } from 'vitest';

import { isServerImportant, mapServerClassification } from '../../../src/utils/server-classification';

const knownCategories = [{ slug: 'promotions', name: 'Promotions' }, { slug: 'needs_response', name: 'Needs Response' }, { slug: 'important', name: 'Important' }];

describe('server classification before AI', () => {
  // Sarv FETCH is canonical; SEARCH syntax is not an alternative flag encoding.
  it('recognizes canonical importance without treating stars or SEARCH aliases as important', () => {
    for (const flag of ['Important', 'IMPORTANT', '$Important', '\\Important']) expect(isServerImportant([flag])).toBe(true);
    for (const flag of ['\\Flagged', '/Important', '//important', 'unimportant']) expect(isServerImportant([flag])).toBe(false);
  });

  // A provider category plus importance must remain two independent decisions.
  it('recovers Sarv flags and a category mailbox without erasing importance', () => {
    expect(mapServerClassification({ flags: ['\\Seen', 'Important', 'needs_response'], folderPath: 'Promotions', knownCategories }))
      .toEqual({ important: true, categories: ['needs_response', 'promotions'], hasClassification: true });
  });

  // Generic keywords/folders cannot accidentally suppress categorization of all mail.
  it('ignores read state, stars, unknown flags and nested user-label leaves', () => {
    expect(mapServerClassification({ flags: ['\\Seen', '\\Flagged', 'custom'], folderPath: 'Work/Promotions', knownCategories }))
      .toEqual({ important: false, categories: [], hasClassification: false });
  });

  // System FLAGS/mailboxes must not match arbitrary user category definitions.
  it('never treats Seen/Flagged/INBOX categories as a provider decision', () => {
    expect(mapServerClassification({ flags: ['\\Seen', '\\Flagged'], folderPath: 'INBOX', knownCategories: [{ slug: 'seen' }, { slug: 'flagged' }, { slug: 'inbox' }] }).hasClassification).toBe(false);
  });

  // Provider plural folder names must resolve the bundled singular category slugs.
  it('maps Sarv Meetings and Invoices to existing category definitions', () => {
    expect(mapServerClassification({ folderPath: 'Meetings', flags: ['Invoices'], knownCategories: [{ slug: 'meeting' }, { slug: 'invoice' }] }).categories).toEqual(['invoice', 'meeting']);
  });

  // Gmail category and Important labels should bypass an unnecessary AI categorizer.
  it('recognizes native Gmail categories and documented bare Important', () => {
    expect(mapServerClassification({ labels: ['\\Inbox', '\\Category_Promotions', 'Important'], knownCategories }))
      .toEqual({ important: true, categories: ['promotions'], hasClassification: true });
  });

  // Promotions stays meaningful without definitions; other native tabs must go through AI.
  it('recovers only Promotions from native bare and backslash categories without definitions', () => {
    expect(mapServerClassification({ labels: ['\\Promotions', 'Updates', 'Forums', 'Personal', '\\Social'] }))
      .toEqual({ important: false, categories: ['promotions'], hasClassification: true });
  });

  // Quoted label normalization must agree with the existing Gmail label mapper.
  it('recognizes quoted importance labels', () => {
    expect(mapServerClassification({ labels: ['"Important"'] }).important).toBe(true);
  });
});


// Read-only native category metadata cannot turn the reserved Important slug into a category flag.
it('preserves native category authority independently from importance and keyword aliases', () => {
  expect(mapServerClassification({ categories: ['updates', 'important'], flags: ['$promotions', 'Important'], folderPath: 'Unknown', knownCategories })).toEqual({ important: true, categories: ['promotions'], hasClassification: true });
  expect(mapServerClassification({ categories: ['important'], flags: null, labels: null }).hasClassification).toBe(false);
});


describe('Gmail provider categories versus Sarv categories', () => {
  // Ignored native tabs cannot retain authority through flags, folder names, mirrors or older discovery metadata.
  it('allows only Gmail Promotions among native category names while preserving Important markers', () => {
    const knownCategories = ['promotions', 'social', 'updates', 'forums', 'personal', 'primary'].map((slug) => ({ slug, name: slug }));
    for (const slug of ['social', 'updates', 'forums', 'personal', 'primary']) {
      expect(mapServerClassification({ providerHost: 'imap.gmail.com', folderPath: slug, flags: [slug], labels: [slug, `Sarv Inbox/${slug}`], categories: [slug], knownCategories })).toEqual({ important: false, categories: [], hasClassification: false });
    }
    expect(mapServerClassification({ labels: ['Important', '\\Spam'], categories: ['promotions', 'social'] })).toEqual({ important: true, categories: ['promotions'], hasClassification: true });
  });

  // Sarv's category flags/folders keep their existing classification semantics; the restriction is Gmail-specific.
  it('retains Sarv Social/Updates and ordinary custom category authority', () => {
    const knownCategories = ['social', 'updates', 'finance'].map((slug) => ({ slug, name: slug }));
    expect(mapServerClassification({ providerHost: 'imap.sarv.com', folderPath: 'social', flags: ['updates', 'finance'], knownCategories })).toEqual({ important: false, categories: ['updates', 'finance', 'social'], hasClassification: true });
    expect(mapServerClassification({ providerHost: 'imap.gmail.com', labels: ['Sarv Inbox/Finance'], knownCategories }).categories).toEqual(['finance']);
  });
});
