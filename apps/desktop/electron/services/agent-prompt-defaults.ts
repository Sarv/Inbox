import { DEFAULT_CATEGORIZATION_TEMPLATE, DEFAULT_DRAFT_TEMPLATE, DEFAULT_PLAN_TEMPLATE } from '@sarvinbox/core';

interface PromptDefault {
  id: string;
  label: string;
  description: string;
  content: string;
}

export interface AgentPromptRepository {
  seedDefault?(prompt: PromptDefault): void;
  getContent?(id: string): string | null;
}

const seededRepositories = new WeakSet<AgentPromptRepository>();

/** Upgrade each account's untouched prompts once; seedDefault preserves edits. */
export function ensureBundledAgentPrompts(repository: AgentPromptRepository | null | undefined): void {
  if (!repository?.seedDefault || seededRepositories.has(repository)) return;
  repository.seedDefault({
    id: 'categorization_system',
    label: 'Categorization (System Prompt)',
    description: 'How the AI classifies emails, picks categories, and decides if a reply should be drafted. Variables: {{userEmail}}, {{userName}}, {{userDomain}}, {{categorySection}}, {{spamPrompt}}.',
    content: DEFAULT_CATEGORIZATION_TEMPLATE,
  });
  repository.seedDefault({
    id: 'agent_plan',
    label: 'Reply Drafter — Plan',
    description: 'Step 1 of reply drafting: decides whether to search old emails or the web before writing. Variables: {{identity}}, {{webOption}}, {{webSearchesField}}, {{webWhenSection}}.',
    content: DEFAULT_PLAN_TEMPLATE,
  });
  repository.seedDefault({
    id: 'agent_draft',
    label: 'Reply Drafter — Draft',
    description: 'Step 2 of reply drafting: writes the actual reply body. Variables: {{identity}}, {{userName}}, {{greeting}}, {{tone}}, {{closing}}.',
    content: DEFAULT_DRAFT_TEMPLATE,
  });
  // A failed seed must remain retryable. A replacement repository/DB gets its
  // own pass; retaining a process-wide account-id cache would miss reopened DBs.
  seededRepositories.add(repository);
}

/** A failed upgrade must not hide an otherwise readable customized policy. */
export function readBundledAgentPrompt(repository: AgentPromptRepository | null | undefined, id: string, onSeedError: (error: unknown) => void): string | null {
  try { ensureBundledAgentPrompts(repository); }
  catch (error) { onSeedError(error); }
  return repository?.getContent?.(id) || null;
}
