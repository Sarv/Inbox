import { DEFAULT_CATEGORIZATION_TEMPLATE, DEFAULT_DRAFT_TEMPLATE, DEFAULT_PLAN_TEMPLATE } from '@sarvinbox/core';
import { describe, expect, it, vi } from 'vitest';

import { ensureBundledAgentPrompts, readBundledAgentPrompt } from '../../../../electron/services/agent-prompt-defaults';

const defaults = {
  categorization_system: DEFAULT_CATEGORIZATION_TEMPLATE,
  agent_plan: DEFAULT_PLAN_TEMPLATE,
  agent_draft: DEFAULT_DRAFT_TEMPLATE,
};

/** Models PromptRepository.seedDefault's existing equality-preserving SQL. */
function accountPrompts(edited = false) {
  const rows = new Map(Object.keys(defaults).map(id => [id, {
    content: edited ? `Custom ${id} for {{userEmail}}` : `Old ${id}`,
    defaultContent: `Old ${id}`,
  }]));
  const repository = {
    getContent: vi.fn((id: string) => rows.get(id)?.content ?? null),
    seedDefault: vi.fn(({ id, content }: { id: string; content: string }) => {
      const old = rows.get(id);
      rows.set(id, { content: !old || old.content === old.defaultContent ? content : old.content, defaultContent: content });
    }),
  };
  return { rows, repository };
}

describe('bundled agent prompt rollout', () => {
  it('upgrades untouched prompts in two distinct account repositories, not only the first account', () => {
    const first = accountPrompts();
    const second = accountPrompts();
    ensureBundledAgentPrompts(first.repository);
    ensureBundledAgentPrompts(second.repository);

    for (const account of [first, second]) {
      expect(account.repository.seedDefault).toHaveBeenCalledTimes(3);
      for (const [id, content] of Object.entries(defaults)) {
        expect(account.rows.get(id)).toEqual({ content, defaultContent: content });
      }
    }
  });

  it('preserves all customized templates while refreshing the Reset defaults in another account', () => {
    const untouched = accountPrompts();
    const customized = accountPrompts(true);
    ensureBundledAgentPrompts(untouched.repository);
    ensureBundledAgentPrompts(customized.repository);

    for (const [id, defaultContent] of Object.entries(defaults)) {
      expect(customized.rows.get(id)).toEqual({ content: `Custom ${id} for {{userEmail}}`, defaultContent });
      expect(untouched.rows.get(id)?.content).toBe(defaultContent);
    }
  });

  it('does not write on each email or reseed after a user edit in the same repository', () => {
    const account = accountPrompts();
    ensureBundledAgentPrompts(account.repository);
    account.rows.get('categorization_system')!.content = 'A new personal policy';
    for (let email = 0; email < 100; email++) ensureBundledAgentPrompts(account.repository);

    expect(account.repository.seedDefault).toHaveBeenCalledTimes(3);
    expect(account.rows.get('categorization_system')?.content).toBe('A new personal policy');
    // Reopening the same account creates another repository and needs its pass.
    const reopened = accountPrompts();
    ensureBundledAgentPrompts(reopened.repository);
    expect(reopened.repository.seedDefault).toHaveBeenCalledTimes(3);
  });

  it('retries a failed partial upgrade instead of caching it as complete', () => {
    const account = accountPrompts();
    const seed = account.repository.seedDefault.getMockImplementation()!;
    account.repository.seedDefault.mockImplementationOnce(seed).mockImplementationOnce(() => { throw new Error('Storage temporarily unavailable'); });

    expect(() => ensureBundledAgentPrompts(account.repository)).toThrow('Storage temporarily unavailable');
    account.rows.get('categorization_system')!.content = 'Custom policy saved before retry';
    ensureBundledAgentPrompts(account.repository);
    ensureBundledAgentPrompts(account.repository);

    expect(account.repository.seedDefault).toHaveBeenCalledTimes(5);
    expect(account.rows.get('categorization_system')).toEqual({ content: 'Custom policy saved before retry', defaultContent: DEFAULT_CATEGORIZATION_TEMPLATE });
    expect(account.rows.get('agent_draft')?.content).toBe(DEFAULT_DRAFT_TEMPLATE);
  });

  it('keeps older storage bridges without editable prompt support usable', () => {
    expect(() => {
      ensureBundledAgentPrompts(undefined);
      ensureBundledAgentPrompts(null);
      ensureBundledAgentPrompts({});
    }).not.toThrow();
  });

  it('still reads the account\'s custom override after an upgrade fails and retries on the next read', () => {
    const account = accountPrompts(true);
    const error = new Error('Seed transaction unavailable');
    const onSeedError = vi.fn();
    account.repository.seedDefault.mockImplementationOnce(() => { throw error; });

    expect(readBundledAgentPrompt(account.repository, 'categorization_system', onSeedError)).toBe('Custom categorization_system for {{userEmail}}');
    expect(onSeedError).toHaveBeenCalledExactlyOnceWith(error);
    expect(account.repository.getContent).toHaveBeenCalledExactlyOnceWith('categorization_system');
    expect(readBundledAgentPrompt(account.repository, 'categorization_system', onSeedError)).toBe('Custom categorization_system for {{userEmail}}');
    expect(account.repository.seedDefault).toHaveBeenCalledTimes(4);
    expect(account.rows.get('categorization_system')?.defaultContent).toBe(DEFAULT_CATEGORIZATION_TEMPLATE);
  });

  it('does not reinterpret a failed custom-template read as an absent policy', () => {
    const account = accountPrompts(true);
    const onSeedError = vi.fn();
    account.repository.getContent.mockImplementation(() => { throw new Error('Template unavailable'); });
    expect(() => readBundledAgentPrompt(account.repository, 'categorization_system', onSeedError)).toThrow('Template unavailable');
    expect(onSeedError).not.toHaveBeenCalled();
  });
});
