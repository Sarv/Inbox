// Repository exports

export { BaseRepository, type DatabaseAccessor } from './base-repository';
export { EmailRepository, buildTags, parseTags, hasTag, addTag, removeTag, imapFlagsToTags, tagsToImapFlags, type ConversationLightRow } from './email-repository';
export { FolderRepository } from './folder-repository';
export { ThreadRepository } from './thread-repository';
export { ContactRepository, type SenderContext } from './contact-repository';
export { AIRepository } from './ai-repository';
export { SearchRepository } from './search-repository';
export { AgentRepository } from './agent-repository';
export { PromptRepository, type AgentPromptTemplate } from './prompt-repository';
export { FilterRepository } from './filter-repository';
export { LabelRepository } from './label-repository';
export { FollowUpRepository } from './follow-up-repository';
export {
  FIRST_SPLIT_SCAN_ROWS_PER_SLOT,
  FirstSplitRepository,
  validateFirstSplitSave,
  type FirstSplitCandidate,
  type FirstSplitCandidateOptions,
  type FirstSplitCandidateReason,
  type FirstSplitFirstMember,
  type FirstSplitWriteInput,
} from './first-split-repository';
