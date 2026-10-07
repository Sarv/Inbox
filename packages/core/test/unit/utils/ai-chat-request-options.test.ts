import { describe, expect, it } from 'vitest';

import { buildAIChatRequestOptions } from '../../../src/utils/ai-provider-auth';

describe('buildAIChatRequestOptions', () => {
  // The same Sarv thinking policy must apply during setup and real mail processing.
  it('keeps the Sarv template extension and shortest reasoning setting', () => {
    expect(buildAIChatRequestOptions({ type: 'sarv' })).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      reasoning_effort: 'minimal',
    });
  });

  // Reasoning defaults belong to the actual model; a family prefix isn't a capability.
  it.each([
    'gpt-5', 'gpt-5-mini', 'gpt-5.1', 'gpt-6', 'o1', 'o3-mini', 'o4-mini',
    'gpt-4o-mini', 'gpt-4.1', 'ordinary-model',
  ])('does not add reasoning or template fields to OpenAI %s', (model) => {
    expect(buildAIChatRequestOptions({ type: 'openai', model })).toEqual({});
  });

  // A custom server can be strict even when a model happens to share a vendor name.
  it.each([
    ['custom', 'gemma-3'],
    ['custom', 'gpt-5-mini'],
    ['custom', 'o3'],
    ['gemini', 'gemini-2.5-flash'],
    ['future-provider', 'gpt-5'],
  ])('keeps unknown capabilities extension-free for %s/%s', (type, model) => {
    const provider = { type, model };
    expect(buildAIChatRequestOptions(provider)).toEqual({});
  });

  // Switching providers must not inherit or mutate a previous request's options.
  it('creates isolated options for each request', () => {
    const first = buildAIChatRequestOptions({ type: 'sarv' });
    (first.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking = true;
    expect(buildAIChatRequestOptions({ type: 'openai' })).toEqual({});
    expect(buildAIChatRequestOptions({ type: 'sarv' })).toEqual({
      chat_template_kwargs: { enable_thinking: false },
      reasoning_effort: 'minimal',
    });
  });
});
