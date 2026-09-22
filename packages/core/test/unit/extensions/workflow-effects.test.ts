import { describe, expect, it } from 'vitest';

import type { ExtensionPermission } from '../../../src/extensions/types';
import {
  SYNCABLE_FLAG_TAGS,
  planWorkflowEffects,
  type WorkflowOutcome,
} from '../../../src/extensions/workflow-effects';
import type { WorkflowResult } from '../../../src/pipeline/types';

function outcome(
  extensionId: string,
  permissions: ExtensionPermission[],
  result: Partial<WorkflowResult>
): WorkflowOutcome {
  return { extensionId, permissions, result: { success: true, ...result } };
}

describe('planWorkflowEffects', () => {
  // Regression: an extension that asked for email:label gets its label, and the
  // tags string stays in the |a|b| shape the rest of the app matches against.
  it('adds a label an extension is permitted to add', () => {
    const plan = planWorkflowEffects('|read|', [
      outcome('vip-scoring', ['email:label'], { labelsToAdd: ['vip'] }),
    ]);

    expect(plan.tags).toBe('|read|vip|');
    expect(plan.changed).toBe(true);
    expect(plan.rejected).toEqual([]);
  });

  // Regression: THE permission check. Nothing else re-checks a workflow result,
  // so without this an extension installed to read mail could label it.
  it('refuses a label from an extension without email:label', () => {
    const plan = planWorkflowEffects('||', [
      outcome('otp-code', ['email:read'], { labelsToAdd: ['vip'] }),
    ]);

    expect(plan.tags).toBe('||');
    expect(plan.changed).toBe(false);
    expect(plan.rejected).toEqual([
      { extensionId: 'otp-code', label: 'vip', reason: 'permission' },
    ]);
  });

  // Regression: flag tags are a separate permission from labels — an extension
  // allowed to categorise mail must not be able to mark it read.
  it('refuses a flag tag from an extension with only email:label', () => {
    const plan = planWorkflowEffects('||', [
      outcome('vip-scoring', ['email:label'], { labelsToAdd: ['starred'] }),
    ]);

    expect(plan.changed).toBe(false);
    expect(plan.flagChanges).toEqual([]);
    expect(plan.rejected[0]).toMatchObject({ label: 'starred', reason: 'permission' });
  });

  // Regression: a permitted flag change must reach the server, not just the
  // local tag string — a star that exists only on this machine is a lie.
  it('records a server flag change for a permitted flag tag', () => {
    const plan = planWorkflowEffects('||', [
      outcome('vip-scoring', ['email:flag'], { labelsToAdd: ['starred'] }),
    ]);

    expect(plan.tags).toBe('|starred|');
    expect(plan.flagChanges).toEqual([{ tag: 'starred', value: true }]);
  });

  // Regression: re-asserting a flag the message already carries would cost one
  // IMAP operation per message on every sync and change nothing.
  it('records no flag change when the message already has the flag', () => {
    const plan = planWorkflowEffects('|starred|', [
      outcome('vip-scoring', ['email:flag'], { labelsToAdd: ['starred'] }),
    ]);

    expect(plan.changed).toBe(false);
    expect(plan.flagChanges).toEqual([]);
  });

  // Regression: `deleted` would hide the message from the list on this machine
  // and nowhere else. There is no sync path for it, so it must be refused
  // rather than written locally.
  it.each(['answered', 'draft', 'deleted'])(
    'refuses the unsyncable flag tag %s even with email:flag',
    (tag) => {
      const plan = planWorkflowEffects('||', [
        outcome('rogue', ['email:flag'], { labelsToAdd: [tag] }),
      ]);

      expect(plan.changed).toBe(false);
      expect(plan.flagChanges).toEqual([]);
      expect(plan.rejected).toEqual([
        { extensionId: 'rogue', label: tag, reason: 'unsupported-flag' },
      ]);
    }
  );

  // Regression: the syncable set is exactly what the sync engine can carry —
  // adding to it without a sync path reintroduces the local-only lie above.
  it('declares only the flag tags the sync engine can push', () => {
    expect([...SYNCABLE_FLAG_TAGS]).toEqual(['read', 'starred']);
  });

  // Regression: removal must work as well as addition, or a workflow can tag a
  // message but never untag it when the reason goes away.
  it('removes a label an extension is permitted to remove', () => {
    const plan = planWorkflowEffects('|vip|read|', [
      outcome('vip-scoring', ['email:label'], { labelsToRemove: ['vip'] }),
    ]);

    expect(plan.tags).toBe('|read|');
    expect(plan.changed).toBe(true);
  });

  // Regression: results arrive in priority order, and a later workflow must be
  // able to override an earlier one rather than both edits fighting.
  it('lets a later workflow override an earlier one', () => {
    const plan = planWorkflowEffects('||', [
      outcome('first', ['email:flag'], { labelsToAdd: ['starred'] }),
      outcome('second', ['email:flag'], { labelsToRemove: ['starred'] }),
    ]);

    expect(plan.tags).toBe('||');
    expect(plan.changed).toBe(false);
    // One net instruction to the server, not two contradictory ones.
    expect(plan.flagChanges).toEqual([{ tag: 'starred', value: false }]);
  });

  // Regression: a workflow that threw still returns a result object. Applying
  // its labels would tag the message as if the work had finished.
  it('ignores labels from a failed workflow', () => {
    const plan = planWorkflowEffects('||', [
      { extensionId: 'x', permissions: ['email:label'], result: { success: false, labelsToAdd: ['vip'] } },
    ]);

    expect(plan.changed).toBe(false);
  });

  // Regression: ' vip ' stored as its own tag is a filter that silently matches
  // nothing, and a non-string label would be coerced into a garbage tag.
  it.each([
    [' vip ', '|vip|'],
    ['', '||'],
    ['   ', '||'],
  ])('normalises the label %j', (label, expected) => {
    const plan = planWorkflowEffects('||', [
      outcome('vip-scoring', ['email:label'], { labelsToAdd: [label] }),
    ]);

    expect(plan.tags).toBe(expected);
  });

  // Regression: a label containing the delimiter would split into two tags and
  // could forge any other tag, including a flag tag.
  it('cannot forge a tag by embedding the delimiter', () => {
    const plan = planWorkflowEffects('||', [
      outcome('rogue', ['email:label'], { labelsToAdd: ['vip|starred'] }),
    ]);

    expect(plan.tags).toBe('|vip_starred|');
    expect(plan.flagChanges).toEqual([]);
  });

  // Regression: a non-string label must be refused, not stringified into a tag.
  it('refuses a label that is not a string', () => {
    const plan = planWorkflowEffects('||', [
      outcome('rogue', ['email:label'], { labelsToAdd: [42 as unknown as string] }),
    ]);

    expect(plan.changed).toBe(false);
    expect(plan.rejected[0]).toMatchObject({ reason: 'invalid' });
  });

  // Regression: the common case is no workflow asking for anything; it must not
  // produce a write.
  it('reports no change for an empty batch', () => {
    const plan = planWorkflowEffects('|read|', []);

    expect(plan).toEqual({ tags: '|read|', changed: false, flagChanges: [], rejected: [] });
  });
});
