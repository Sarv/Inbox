import { classifyFolder, type ClassifiableFolder } from '../../config/folder-mapping';

/** Shared reader behavior for a cited conversation outside the mailbox list. */
export interface EmailReaderOptions {
  onBack?: () => void;
  /** Use the loaded, owning thread and prevent navigation into an unrelated inbox. */
  threadOnly?: boolean;
  /** Review previews can preserve unread state; normal readers mark opened mail read. */
  autoMarkRead?: boolean;
  /** One-shot, account-bound navigation intent; uses the normal inline composer. */
  replyAllRequest?: { id: number; accountId: string; emailId: string };
}
export function readerCurrentUserEmail(input: {
  threadOnly?: boolean;
  threadAccountId: string | null;
  accounts: ReadonlyArray<{ id: string; email: string }>;
  fallback: string;
}): string {
  return input.threadOnly
    ? input.accounts.find(account => account.id === input.threadAccountId)?.email || input.fallback
    : input.fallback;
}

export function readerFolderFlags(input: {
  threadOnly?: boolean;
  tags?: string | null;
  selectedFolder: ClassifiableFolder | null | undefined;
}): { isInTrash: boolean; isInSpam: boolean } {
  if (input.threadOnly) {
    const roles = (input.tags || '').split('|').filter(Boolean).map(path => classifyFolder({ path }));
    return { isInTrash: roles.includes('trash'), isInSpam: roles.includes('spam') };
  }
  const path = input.selectedFolder?.path.toLowerCase() || '';
  return {
    isInTrash: !!input.selectedFolder && classifyFolder(input.selectedFolder) === 'trash',
    isInSpam: path.includes('spam') || path.includes('junk') || input.selectedFolder?.specialUse === '\\Junk',
  };
}
