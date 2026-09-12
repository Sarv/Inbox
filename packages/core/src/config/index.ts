// Config module exports

export {
  HIDDEN_PROVIDER_FOLDERS,
  VIRTUAL_FOLDERS,
  STANDARD_FOLDER_MAP,
  SPECIAL_USE_TO_TYPE,
  DEFAULT_FOLDER_CONFIG,
  shouldHideFolder,
  getStandardFolderType,
  getFolderDisplayName,
  classifyFolder,
  folderTypeMatchStrength,
  findFolderByType,
  buildStandardFolderAliasMap,
  describeDuplicateRoles,
  describeFolderSyncState,
  duplicateRoleCandidates,
  isInboxFolder,
  isSentFolder,
  isDraftsFolder,
  isTrashFolder,
  isSpamFolder,
  isArchiveFolder,
  isAllMailSuperset,
} from './folder-mapping';

export type { VirtualFolder, FolderConfig, StandardFolderType, ClassifiableFolder } from './folder-mapping';

export {
  SYNC_RECENT_WINDOW_DAYS,
  LARGE_MAILBOX_THRESHOLD,
  BACKFILL_UID_SPAN,
  recentWindowCutoffSeconds,
  recentWindowCutoffDate,
} from './sync';
