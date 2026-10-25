import { describe, expect, it } from 'vitest';

import { compactInboxAssistantContent, type InboxAssistantContentMessage } from '../../../../electron/services/inbox-assistant-content';

const original = [
  'Quotation Q-204 revision 1: Total INR 270,000 excluding GST. Valid for 21 days.',
  'Deployment includes the identity directory, support and migration. '.repeat(9),
  'Regards, Alice\nDesignation: Solutions Director\nPhone: +91 90000 00123',
].join('\n');
const message = (id: string, text: string, overrides: Partial<InboxAssistantContentMessage> = {}): InboxAssistantContentMessage => ({
  id, accountId: 'account-a', threadId: 'thread-a', date: Date.UTC(2026, 9, 2) / 1000, text, ...overrides,
});
const header = 'On Thu, 1 Oct 2026 at 10:00, Alice <alice@example.test> wrote:\n';

describe('Inbox Agent raw chat-content packing', () => {
  it('shares quoted copies with the real original while keeping authored replies and all attribution headers', () => {
    const inputs = [message('S1', `Approved with a staged rollout.\n\n${header}${original}`),
      message('S2', `Please confirm the deployment date.\n\n${header}${original}`), message('S3', original)];
    const snapshot = structuredClone(inputs);
    const result = compactInboxAssistantContent(inputs);
    expect(result.reusedTurns).toBe(2);
    expect(result.messages[0]!.text).toContain('Approved with a staged rollout.');
    expect(result.messages[1]!.text).toContain('Please confirm the deployment date.');
    expect(result.messages[0]!.text).toContain(header);
    expect(result.messages[1]!.text).toContain(header);
    expect(result.messages[0]!.text).toContain('shared with S3, turn 1');
    expect(result.messages[2]!.text).toBe(inputs[2]!.text);
    expect(result.messages[2]!.text).toContain('Solutions Director');
    expect(result.messages[2]!.text).toContain('+91 90000 00123');
    expect(result.submittedChars).toBeLessThan(result.originalChars * 0.6);
    expect(inputs).toEqual(snapshot);
  });

  it('keeps unique quoted history when the original was never stored and shares only later exact copies', () => {
    const outlook = '---------- Forwarded Message ----------\nFrom: Alice <alice@example.test>\nSent: 1 October 2026\nTo: Buyer <buyer@example.test>\nSubject: Directory quotation\n';
    const laterHeader = outlook.replace('1 October', '2 October').replace('buyer@example.test', 'other-buyer@example.test');
    const result = compactInboxAssistantContent([message('S1', `For your records.\n${outlook}${original}`),
      message('S2', `Forwarding again.\n${laterHeader}${original}`)]);
    expect(result.reusedTurns).toBe(1);
    expect(result.messages[0]!.text).toContain(original);
    expect(result.messages[1]!.text).toContain('shared with S1, turn 2');
    expect(result.messages[1]!.text).toContain(laterHeader);
  });

  it('does not merge changed prices, punctuation, dates, recipients or contact signatures', () => {
    const variants = [original, original.replace('270,000', '275,000'), original.replace('revision 1', 'revision 2'),
      original.replace('21 days', '14 days'), original.replace('00123', '00456'), original.replace('excluding GST', 'including GST'),
      original.replace('Director', 'Manager'), original.replace('270,000', '27.000')];
    const inputs = variants.map((body, index) => message(`S${index + 1}`, `Forwarded for buyer-${index}@example.test.\n${header}${body}`));
    const result = compactInboxAssistantContent(inputs);
    expect(result.reusedTurns).toBe(0);
    expect(result.messages.map(item => item.text)).toEqual(inputs.map(item => item.text));
  });

  it('retains different CC headers and CC lines inside unique quoted content', () => {
    const forward = '---------- Forwarded Message ----------\nFrom: Alice <alice@example.test>\nDate: 1 October 2026\nCC: first@example.test\n';
    const secondHeader = forward.replace('first@example.test', 'second@example.test');
    const bodyWithCc = original + '\nPlease circulate the contractual details.\nCC: legal@example.test';
    const differentBodyCc = bodyWithCc.replace('legal@example.test', 'finance@example.test');
    const result = compactInboxAssistantContent([message('S1', `CC: outer-first@example.test\n\n${forward}${original}`),
      message('S2', `CC: outer-second@example.test\n\n${secondHeader}${original}`),
      message('S3', `For review.\n${header}${bodyWithCc}`), message('S4', `For review.\n${header}${differentBodyCc}`)]);
    expect(result.reusedTurns).toBe(1);
    expect(result.messages[0]!.text).toContain('CC: outer-first@example.test');
    expect(result.messages[1]!.text).toContain('CC: outer-second@example.test');
    expect(result.messages[0]!.text).toContain('CC: first@example.test');
    expect(result.messages[1]!.text).toContain('CC: second@example.test');
    expect(result.messages[2]!.text).toContain(bodyWithCc);
    expect(result.messages[3]!.text).toContain(differentBodyCc);
  });

  it('does not flatten different table cell boundaries, indentation or internal newlines into duplicate turns', () => {
    const common = '\n' + 'The pricing cells above have distinct contractual meanings. '.repeat(8);
    const bodies = ['Product\tCount Cost\nDirectory\t2 700', 'Product Count\tCost\nDirectory 2\t700',
      'Product Count Cost\nDirectory 2 700', 'Product Count Cost Directory 2 700', '\tProduct Count Cost\nDirectory 2 700'];
    const inputs = bodies.map((body, index) => message(`S${index + 1}`, `Forwarding pricing.\n${header}${body}${common}`));
    const result = compactInboxAssistantContent(inputs);
    expect(result.reusedTurns).toBe(0);
    expect(result.messages.map(item => item.text)).toEqual(inputs.map(item => item.text));
  });

  it('never shares content across accounts, conversations or unknown conversation ownership', () => {
    const text = `Forwarded for information.\n${header}${original}`;
    const result = compactInboxAssistantContent([message('S1', text), message('S2', text, { accountId: 'other-account' }),
      message('S3', text, { threadId: 'other-thread' }), message('S4', text, { threadId: undefined }), message('S5', text, { threadId: undefined })]);
    expect(result.reusedTurns).toBe(0);
    expect(result.messages.every(item => item.text === text)).toBe(true);
  });

  it('keeps equal real messages and short conversational turns rather than collapsing their sending events', () => {
    const inputs = [message('S1', original), message('S2', original), message('S3', `Thanks.\n${header}Approved.`), message('S4', `Thanks again.\n${header}Approved.`)];
    const result = compactInboxAssistantContent(inputs);
    expect(result.reusedTurns).toBe(0);
    expect(result.messages.map(item => item.text)).toEqual(inputs.map(item => item.text));
  });
});
