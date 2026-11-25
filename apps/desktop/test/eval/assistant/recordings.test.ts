import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AssistantHarness } from '../../helpers/assistant-harness';

import { loadRecordings, replayRecording } from './live-provider';
import { createEvalHarness } from './seed';

/**
 * Agent runs recorded from real providers (see live-provider.ts), replayed:
 * the model's own turns drive the CURRENT host on the same seeded mailbox.
 *
 * What breaks if this goes red: a change to a tool, a tool result's format, or
 * the grounding check has changed what a real model's recorded run ends with
 * (it no longer reaches or cites the email it did). That may be the point of
 * the change. Then re-record, and say so in the commit message. It is never a
 * reason to loosen the grounding check.
 */
const recordings = (await loadRecordings(join(__dirname, 'recorded'))).filter(item => item.recording.version === 2);

let harness: AssistantHarness;
beforeAll(async () => { harness = await createEvalHarness(undefined, { agent: () => ({ text: 'unused' }) }); }, 120_000);
afterAll(async () => { await harness.close(); });

describe('recorded provider runs', () => {
  it.each(recordings.filter(item => item.recording.turns.length && item.recording.outcome).map(item => [item.file, item.recording] as const))(
    '%s ends as it did when recorded', async (_file, recording) => {
      expect(await replayRecording(harness, recording)).toEqual(recording.outcome);
    }, 60_000);

  // Breaks: nothing. It reports how much real-model evidence the suite holds,
  // so an empty folder reads as "none recorded yet" rather than as coverage.
  it('says how many recordings there are', () => {
    const replayable = recordings.filter(item => item.recording.turns.length && item.recording.outcome).length;
    process.stdout.write(`[assistant-eval] ${recordings.length} recorded provider ${recordings.length === 1 ? 'run' : 'runs'}`
      + `${recordings.length ? `, ${replayable} replayable` : ' (none recorded yet: see docs/TESTING.md)'}\n`);
    expect(replayable).toBeLessThanOrEqual(recordings.length);
  });
});
