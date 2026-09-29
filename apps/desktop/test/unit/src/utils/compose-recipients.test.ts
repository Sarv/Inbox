import { describe, expect, it } from 'vitest';

import { mergeRecipientEmails } from '../../../../src/utils/compose-recipients';

describe('mergeRecipientEmails', () => {
  // Breaks: an address typed but not yet committed as a chip is dropped from the send.
  it('adds a typed address that has not become a chip yet', () => {
    expect(mergeRecipientEmails('a@x.org, b@x.org', 'c@x.org')).toEqual(['a@x.org', 'b@x.org', 'c@x.org']);
  });

  // Breaks: half-typed text ("jo") is sent to as if it were an address.
  it('ignores typed text that is not an address, and blank entries', () => {
    expect(mergeRecipientEmails('a@x.org, ,', 'jo')).toEqual(['a@x.org']);
    expect(mergeRecipientEmails('', '')).toEqual([]);
  });

  // Breaks: a recipient in both the chips and the box gets the mail twice.
  it('lists each address once', () => {
    expect(mergeRecipientEmails('a@x.org', 'a@x.org')).toEqual(['a@x.org']);
  });
});
