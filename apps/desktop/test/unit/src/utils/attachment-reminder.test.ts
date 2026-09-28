import { afterEach, describe, expect, it, vi } from 'vitest';

import { SETTINGS_KEY } from '../../../../src/config/inbox-types';
import { useConfirmStore } from '../../../../src/store/confirm-service';
import {
  checkAttachmentBeforeSend,
  confirmAttachmentBeforeSend,
  findAttachmentMention,
  missingAttachmentMention,
  type OutgoingForAttachmentCheck,
} from '../../../../src/utils/attachment-reminder';

// What breaks if this suite goes red: the "you forgot the attachment" prompt.
// Too quiet and the invoice goes out without the invoice; too eager and every
// reply in a thread titled "Report attached" nags, until the user switches it
// off and loses the protection entirely.

const mail = (over: Partial<OutgoingForAttachmentCheck> = {}): OutgoingForAttachmentCheck => ({
  subject: 'Hello',
  body: 'Hi there',
  attachmentCount: 0,
  subjectIsOwn: true,
  ...over,
});

describe('findAttachmentMention', () => {
  // Each of these is a real way people say "a file is coming". Missing one is
  // a missed warning.
  it.each([
    ['Please see the attached report.', 'attached'],
    ["I'm attaching the slides now", 'attaching'],
    ['The attachment has the numbers', 'attachment'],
    ['Both attachments are signed', 'attachments'],
    ['I will attach it', 'attach'],
    ['Enclosed is the contract', 'Enclosed'],
    ['Find the enclosure below', 'enclosure'],
    ['PFA the invoice', 'PFA'],
    ['ATTACHED: final version', 'ATTACHED'],
  ])('finds the mention in %j', (text, word) => {
    expect(findAttachmentMention(text)).toBe(word);
  });

  // Words that merely contain the letters must not trigger — "detached" is not
  // a promise of a file.
  it.each(['The house is detached', 'Reattachable parts', 'Nothing to see here', 'pfaff sewing machine'])(
    'ignores %j',
    (text) => {
      expect(findAttachmentMention(text)).toBeNull();
    },
  );

  // Saying there is no attachment is the opposite of forgetting one.
  it.each(['No attachment this time', 'Sending without attachments', 'It is not attached yet', 'without an attachment'])(
    'ignores the negated mention in %j',
    (text) => {
      expect(findAttachmentMention(text)).toBeNull();
    },
  );

  // A negation elsewhere must not hide a real mention in the same message.
  it('still finds a real mention next to a negated one', () => {
    expect(findAttachmentMention('No attachment yesterday, but the report is attached now')).toBe('attached');
  });

  // Quoted lines are the other person's words; their "attached" is not ours.
  it('ignores plain-text quoted lines', () => {
    expect(findAttachmentMention('Thanks!\n> See the attached file\n>> attachment')).toBeNull();
    expect(findAttachmentMention('Thanks!\n  > attached')).toBeNull();
  });

  it('reads an empty or missing text as no mention', () => {
    expect(findAttachmentMention('')).toBeNull();
    expect(findAttachmentMention(null)).toBeNull();
    expect(findAttachmentMention(undefined)).toBeNull();
  });
});

describe('missingAttachmentMention', () => {
  // The core promise: a mention with nothing attached is flagged.
  it('flags a body mention with no attachment', () => {
    expect(missingAttachmentMention(mail({ body: 'Report attached' }))).toBe('attached');
  });

  // With a file attached there is nothing to warn about, whatever the text says.
  it('never flags a message that has an attachment', () => {
    expect(missingAttachmentMention(mail({ body: 'Report attached', attachmentCount: 1 }))).toBeNull();
  });

  // "Invoice attached" in a new message's subject is as strong a signal as the body.
  it('flags a mention in the user-written subject', () => {
    expect(missingAttachmentMention(mail({ subject: 'Invoice attached', body: 'Hi' }))).toBe('attached');
  });

  // Regression guard: a reply inherits "Re: Report attached" — flagging it would
  // nag on every "thanks!" in the thread.
  it('ignores an inherited reply/forward subject', () => {
    expect(missingAttachmentMention(mail({ subject: 'Re: Report attached', body: 'Thanks!', subjectIsOwn: false })))
      .toBeNull();
  });

  // The body is still checked on a reply.
  it('still checks the body of a reply', () => {
    expect(missingAttachmentMention(mail({ subject: 'Re: x', body: 'Updated file attached', subjectIsOwn: false })))
      .toBe('attached');
  });

  it('passes a message with no mention anywhere', () => {
    expect(missingAttachmentMention(mail())).toBeNull();
  });
});

describe('confirmAttachmentBeforeSend', () => {
  // The switch in Settings must turn the prompt off completely.
  it('never asks when the setting is off', async () => {
    const ask = vi.fn();
    await expect(confirmAttachmentBeforeSend(mail({ body: 'attached' }), { enabled: false, ask })).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  // Nothing to warn about means no prompt — a dialog on every send would be noise.
  it('sends without asking when nothing is missing', async () => {
    const ask = vi.fn();
    await expect(confirmAttachmentBeforeSend(mail(), { enabled: true, ask })).resolves.toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  // The prompt quotes the word the user wrote and is not styled as destructive.
  it('asks, quoting the word, and follows "Send anyway"', async () => {
    const ask = vi.fn().mockResolvedValue(true);
    await expect(confirmAttachmentBeforeSend(mail({ body: 'PFA' }), { enabled: true, ask })).resolves.toBe(true);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('“PFA”'), confirmLabel: 'Send anyway', destructive: false }),
    );
  });

  // "Go back" must stop the send, so the user can add the file.
  it('stops the send on "Go back"', async () => {
    const ask = vi.fn().mockResolvedValue(false);
    await expect(confirmAttachmentBeforeSend(mail({ body: 'attached' }), { enabled: true, ask })).resolves.toBe(false);
  });
});

describe('checkAttachmentBeforeSend', () => {
  const stubSettings = (raw: string | null) =>
    vi.stubGlobal('localStorage', { getItem: (key: string) => (key === SETTINGS_KEY ? raw : null), setItem: () => {} });

  afterEach(() => {
    vi.unstubAllGlobals();
    useConfirmStore.setState({ current: null });
  });

  // On by default: a user who never opened Settings still gets the warning,
  // and it goes through the app-wide dialog that sits above the composer.
  it('raises the app-wide dialog by default and resolves with the answer', async () => {
    stubSettings(null);
    const pending = checkAttachmentBeforeSend(mail({ body: 'attached' }));
    expect(useConfirmStore.getState().current?.title).toBe('Send without an attachment?');
    useConfirmStore.getState().resolve(false);
    await expect(pending).resolves.toBe(false);
  });

  // The stored switch is honoured on the send path.
  it('does not ask when the stored setting is off', async () => {
    stubSettings(JSON.stringify({ attachmentReminder: false }));
    await expect(checkAttachmentBeforeSend(mail({ body: 'attached' }))).resolves.toBe(true);
    expect(useConfirmStore.getState().current).toBeNull();
  });
});
