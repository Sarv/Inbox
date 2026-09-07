// Pure evaluation of user filter rules against an email. No I/O, no folder
// resolution — callers decide how to apply the returned actions. Kept pure so
// it is trivially unit-testable and reusable by both the ingest path (core) and
// any future consumer.

import { findFolderByType } from '../config/folder-mapping';
import type { FilterAction, FilterCondition, FilterRule } from '../types/filters';
import type { EmailRecord } from '../types/models';

import { addTag, hasTag, removeTag } from './tags';

/** The text a condition's field maps to on an email (lowercased by the caller). */
function fieldValue(email: EmailRecord, field: FilterCondition['field']): string {
  switch (field) {
    case 'from':
      return `${email.fromAddress ?? ''} ${email.fromName ?? ''}`;
    case 'to':
      return email.toAddress ?? '';
    case 'cc':
      return email.ccAddress ?? '';
    case 'subject':
      return email.subject ?? '';
    case 'body':
      return email.cleanBody ?? '';
    case 'domain': {
      const addr = email.fromAddress ?? '';
      const at = addr.lastIndexOf('@');
      return at >= 0 ? addr.slice(at + 1) : '';
    }
    default:
      return '';
  }
}

function testCondition(email: EmailRecord, condition: FilterCondition): boolean {
  const haystack = fieldValue(email, condition.field).toLowerCase();
  const needle = (condition.value ?? '').trim().toLowerCase();
  // An empty needle is a misconfigured condition — never match on it.
  if (!needle) return false;

  switch (condition.operator) {
    case 'contains':
      return haystack.includes(needle);
    case 'notContains':
      return !haystack.includes(needle);
    case 'equals':
      return haystack.trim() === needle;
    case 'startsWith':
      return haystack.trimStart().startsWith(needle);
    case 'endsWith':
      return haystack.trimEnd().endsWith(needle);
    default:
      return false;
  }
}

/** Whether an email satisfies a single rule (AND/OR across its conditions). */
export function emailMatchesRule(email: EmailRecord, rule: FilterRule): boolean {
  if (!rule.enabled || rule.conditions.length === 0) return false;
  return rule.matchType === 'any'
    ? rule.conditions.some((c) => testCondition(email, c))
    : rule.conditions.every((c) => testCondition(email, c));
}

/**
 * Evaluate all rules (highest priority first) and return the flattened list of
 * actions to apply, honoring `stopProcessing`. Duplicate/ conflicting actions
 * are left for the caller to resolve when applying.
 */
export function collectFilterActions(email: EmailRecord, rules: FilterRule[]): FilterAction[] {
  const ordered = rules
    .filter((r) => r.enabled)
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

  const actions: FilterAction[] = [];
  for (const rule of ordered) {
    if (emailMatchesRule(email, rule)) {
      actions.push(...rule.actions);
      if (rule.stopProcessing) break;
    }
  }
  return actions;
}

interface FolderLike {
  id: string;
  path: string;
  specialUse?: string | null;
}

/**
 * Compute the local tag/folder result of applying a set of filter actions to an
 * email. Pure — resolves target folders from the provided `folders` list and
 * returns the new tags/folderId (does no I/O). Shared by the ingest path and the
 * "apply to existing emails" path so both behave identically.
 *
 * Note: this is the LOCAL projection only. Callers that also want the change on
 * the server enqueue the matching IMAP operations separately.
 */
export function computeFilterActionResult(
  email: { tags?: string | null; folderId: string },
  actions: FilterAction[],
  folders: FolderLike[],
): { tags: string; folderId: string; changed: boolean } {
  let tags = email.tags || '';
  let folderId = email.folderId;
  let changed = false;

  const moveTo = (target: FolderLike | null | undefined) => {
    if (!target || target.id === folderId) return;
    // Resolve the source folder AT CALL TIME, never once up front: a rule can
    // carry two move actions (e.g. archive then delete) and each move must drop
    // the tag of the folder the message is in right now. Hoisting this out left
    // the intermediate folder's tag behind (`|Archive|Trash|`), so the message
    // showed up in BOTH folders.
    const currentPath = folders.find((f) => f.id === folderId)?.path;
    if (currentPath && hasTag(tags, currentPath)) tags = removeTag(tags, currentPath);
    if (!hasTag(tags, target.path)) tags = addTag(tags, target.path);
    folderId = target.id;
    changed = true;
  };
  const addFlag = (tag: string) => {
    if (tag && !hasTag(tags, tag)) {
      tags = addTag(tags, tag);
      changed = true;
    }
  };

  for (const action of actions) {
    switch (action.type) {
      case 'markRead': addFlag('read'); break;
      case 'star': addFlag('starred'); break;
      case 'applyLabel': if (action.value) addFlag(action.value); break;
      case 'moveToSpam': moveTo(findFolderByType(folders as any, 'spam') as FolderLike | null); break;
      case 'archive': moveTo(findFolderByType(folders as any, 'archive') as FolderLike | null); break;
      case 'delete': moveTo(findFolderByType(folders as any, 'trash') as FolderLike | null); break;
      case 'moveToFolder': if (action.value) moveTo(folders.find((f) => f.path === action.value)); break;
    }
  }

  return { tags, folderId, changed };
}
