import { cleanEmailHtmlForLLM } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

// What breaks if this file fails: the body the categorizer's prompt sees. The
// categorizer used to try the chat view's whole-thread conversation cache
// first for a threaded email; that lookup wanted a cached shape no writer ever
// stored, so every email already went through the raw-body path. The branch
// was removed with the cache — this pins that the effective input did NOT
// change: a threaded email is categorized from its own cleaned raw body. The
// helper takes no storage at all, so it cannot read any cache.

vi.mock('../../../../electron/shared', () => ({ getMainWindow: vi.fn(), requireStorage: vi.fn() }));
vi.mock('../../../../electron/services/net-fetch', () => ({ chromiumFetch: vi.fn() }));

import { categorizationBodyOf } from '../../../../electron/services/ai-categorization-service';
import { emailRecord } from '../../../helpers/email-fixtures';

describe('categorizationBodyOf', () => {
  // Breaks: removing the conversation-cache branch changed the categorizer's
  // input — a threaded email must still be categorized from its own cleaned
  // raw body, stripped of style and inline images, within the prompt cap.
  it('categorizes a threaded email from cleanEmailHtmlForLLM(rawBody), capped for the prompt', () => {
    const rawBody = `<style>p{color:red}</style><p>Please approve the budget.</p><img src="data:image/png;base64,AAAA">${'<p>more</p>'.repeat(400)}`;
    const email = emailRecord({ threadId: 'thread-with-many', rawBody, cleanBody: 'plain text version' });
    const body = categorizationBodyOf(email);
    expect(body).toBe(cleanEmailHtmlForLLM(rawBody, { maxLength: 1000 }));
    expect(body).toContain('Please approve the budget.');
    expect(body.length).toBeLessThanOrEqual(1000);
  });

  // Breaks: a header-only row (body not downloaded) sends the LLM nothing
  // although a text body exists.
  it('falls back to cleanBody without a raw body, and to empty without either', () => {
    expect(categorizationBodyOf(emailRecord({ rawBody: '', cleanBody: 'text only' }))).toBe('text only');
    expect(categorizationBodyOf(emailRecord({ rawBody: '', cleanBody: '' }))).toBe('');
  });
});
