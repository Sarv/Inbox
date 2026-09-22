/**
 * Turning what an extension workflow ASKED for into what the host will actually
 * do — the point where a declared permission stops being documentation.
 *
 * `processEmail` collects results from every workflow and hands them back
 * untouched: a workflow can return any label it likes, whether or not its
 * manifest asked for `email:label`. Nothing downstream re-checks that, so this
 * is the check. An extension that was installed for one job cannot quietly
 * acquire another by returning a field.
 *
 * Kept pure and free of storage/IMAP so the rules can be tested directly: given
 * these results and these permissions, exactly these tags change and exactly
 * these server flags follow.
 */

import type { WorkflowResult } from '../pipeline/types';
import { FLAG_TAG_NAMES, addTag, hasTag, removeTag, sanitizeTagName } from '../utils/tags';

import type { ExtensionPermission } from './types';

/**
 * The flag tags the host can carry back to the server.
 *
 * `answered`, `draft` and `deleted` are deliberately absent. Each has real
 * meaning to IMAP, none has a sync path here, and writing one locally would
 * produce a message that looks answered — or looks deleted, and vanishes from
 * the list — on this machine and nowhere else. A silent local-only lie about
 * mail state is worse than refusing the request, so the request is refused.
 */
export const SYNCABLE_FLAG_TAGS = ['read', 'starred'] as const;

export type SyncableFlagTag = (typeof SYNCABLE_FLAG_TAGS)[number];

/** One workflow's output, paired with what its extension is allowed to do. */
export interface WorkflowOutcome {
  extensionId: string;
  permissions: readonly ExtensionPermission[];
  result: WorkflowResult;
}

/** A server-visible flag change, already deduplicated to a final state. */
export interface ExtensionFlagChange {
  tag: SyncableFlagTag;
  value: boolean;
}

/** A label the host declined to apply, and why. */
export interface RejectedLabel {
  extensionId: string;
  label: string;
  reason: 'permission' | 'unsupported-flag' | 'invalid';
}

export interface WorkflowEffectPlan {
  /** The tags string to persist. Equal to the input when nothing applied. */
  tags: string;

  /** Whether `tags` differs from what was passed in. */
  changed: boolean;

  /** Flag changes to push to the server, in the order they must be applied. */
  flagChanges: ExtensionFlagChange[];

  /** Everything that was asked for and refused. */
  rejected: RejectedLabel[];
}

function isFlagTag(tag: string): boolean {
  return (FLAG_TAG_NAMES as readonly string[]).includes(tag);
}

function isSyncableFlagTag(tag: string): tag is SyncableFlagTag {
  return (SYNCABLE_FLAG_TAGS as readonly string[]).includes(tag);
}

/**
 * Work out the single set of changes a batch of workflow results amounts to.
 *
 * Results are applied in the order given — the same priority order the host ran
 * them in — so a later workflow removing what an earlier one added is a
 * deliberate override, and the last word wins for both the tag string and the
 * flag pushed to the server.
 */
export function planWorkflowEffects(
  currentTags: string,
  outcomes: readonly WorkflowOutcome[]
): WorkflowEffectPlan {
  const startingTags = currentTags || '||';
  let tags = startingTags;
  const flagChanges = new Map<SyncableFlagTag, boolean>();
  const rejected: RejectedLabel[] = [];

  const apply = (
    extensionId: string,
    permissions: readonly ExtensionPermission[],
    rawLabel: string,
    add: boolean
  ): void => {
    // Trimmed and type-checked before anything else: an extension is free to
    // return a number, a null, or ' vip ', and ' vip ' as a distinct tag from
    // 'vip' is a bug the user would see as a filter that matches nothing.
    const tag = typeof rawLabel === 'string' ? sanitizeTagName(rawLabel.trim()) : '';
    if (!tag) {
      rejected.push({ extensionId, label: String(rawLabel), reason: 'invalid' });
      return;
    }

    if (isFlagTag(tag)) {
      if (!isSyncableFlagTag(tag)) {
        rejected.push({ extensionId, label: tag, reason: 'unsupported-flag' });
        return;
      }
      if (!permissions.includes('email:flag')) {
        rejected.push({ extensionId, label: tag, reason: 'permission' });
        return;
      }
      // Only record a server round-trip when the local state actually moves.
      // Re-asserting a flag a message already has costs an IMAP operation and
      // changes nothing — on a first sync, once per message.
      if (hasTag(tags, tag) === add) return;
      tags = add ? addTag(tags, tag) : removeTag(tags, tag);
      flagChanges.set(tag, add);
      return;
    }

    if (!permissions.includes('email:label')) {
      rejected.push({ extensionId, label: tag, reason: 'permission' });
      return;
    }
    tags = add ? addTag(tags, tag) : removeTag(tags, tag);
  };

  for (const outcome of outcomes) {
    // A failed workflow's labels are not applied: the result exists to carry the
    // error, and half-finished work should not leave the message tagged as if it
    // had succeeded.
    if (!outcome.result.success) continue;

    for (const label of outcome.result.labelsToAdd ?? []) {
      apply(outcome.extensionId, outcome.permissions, label, true);
    }
    for (const label of outcome.result.labelsToRemove ?? []) {
      apply(outcome.extensionId, outcome.permissions, label, false);
    }
  }

  return {
    tags,
    changed: tags !== startingTags,
    flagChanges: [...flagChanges].map(([tag, value]) => ({ tag, value })),
    rejected,
  };
}
