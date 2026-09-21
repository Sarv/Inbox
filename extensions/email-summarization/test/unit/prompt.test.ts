import type { EmailForSummary } from '@sarvinbox/core/extension-sdk';
import { describe, expect, it } from 'vitest';


import {
  EMAIL_SYSTEM_PROMPT,
  MAX_SUMMARY_TOKENS,
  THREAD_SYSTEM_PROMPT,
  buildEmailPrompt,
  buildThreadPrompt,
} from '../../src/prompt';

function email(overrides: Partial<EmailForSummary> = {}): EmailForSummary {
  return {
    id: 'msg-1',
    subject: 'Renewal',
    fromAddress: 'dana@example.com',
    fromName: 'Dana',
    toAddress: 'me@example.com',
    date: 1_760_000_000,
    body: 'body',
    ...overrides,
  };
}

describe('system prompts', () => {
  // Regression: the answer is parsed as JSON. Dropping the instruction turns
  // every summary into an unparsable paragraph.
  it('ask for a single JSON object and nothing else', () => {
    for (const prompt of [EMAIL_SYSTEM_PROMPT, THREAD_SYSTEM_PROMPT]) {
      expect(prompt).toContain('single JSON object');
      expect(prompt).toContain('"summary"');
      expect(prompt).toContain('"key_points"');
      expect(prompt).toContain('"confidence"');
    }
  });

  // Regression: a summary that invents a deadline is worse than no summary,
  // because it reads exactly like one that did not.
  it('forbid inferring anything the mail does not say', () => {
    for (const prompt of [EMAIL_SYSTEM_PROMPT, THREAD_SYSTEM_PROMPT]) {
      expect(prompt).toContain('Never infer, guess or fill gaps');
    }
  });

  // Regression: the thread prompt has to explain the separator and the order,
  // or the model reports the first message as the latest state.
  it('tell the thread prompt how the messages are laid out', () => {
    expect(THREAD_SYSTEM_PROMPT).toContain('oldest first');
    expect(THREAD_SYSTEM_PROMPT).toContain('three dashes');
    expect(THREAD_SYSTEM_PROMPT).toContain('"participants"');
  });
});

describe('buildEmailPrompt', () => {
  // Regression: an unbounded completion is an unbounded bill for a paragraph.
  it('carries the rendered message and a token cap', () => {
    const options = buildEmailPrompt('From: Dana\n\nhello');
    expect(options.systemPrompt).toBe(EMAIL_SYSTEM_PROMPT);
    expect(options.userPrompt).toContain('From: Dana');
    expect(options.maxTokens).toBe(MAX_SUMMARY_TOKENS);
  });
});

describe('buildThreadPrompt', () => {
  // Regression: the subject is the one piece of context that says what the
  // thread is about when every body is a one-line reply.
  it('states the subject and the message count once', () => {
    const options = buildThreadPrompt('rendered', [email(), email({ id: 'msg-2' })]);
    expect(options.userPrompt).toContain('Thread subject: Renewal');
    expect(options.userPrompt).toContain('Messages: 2');
    expect(options.userPrompt).toContain('rendered');
  });

  // Regression: an empty first subject is common (a reply with the subject
  // stripped); falling through to the next one keeps the context.
  it('takes the first message that actually has a subject', () => {
    const options = buildThreadPrompt('rendered', [
      email({ subject: '   ' }),
      email({ id: 'msg-2', subject: 'Contract' }),
    ]);
    expect(options.userPrompt).toContain('Thread subject: Contract');
  });

  // Regression: "undefined" as a subject is a fact the model will narrate back.
  it('says so when no message has a subject', () => {
    const options = buildThreadPrompt('rendered', [email({ subject: '' })]);
    expect(options.userPrompt).toContain('Thread subject: (no subject)');
  });
});
