import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { inboxAssistantPromptHash, loadRecordings, replayRecording } from './live-provider';

/**
 * Replies recorded from real providers (see live-provider.ts), replayed
 * through the verifier.
 *
 * What breaks if this goes red: a change to how model replies are parsed or
 * verified treats a reply a real model actually wrote differently from before.
 * That may be the point of the change (a quote that used to be rejected is now
 * accepted). Then re-record, or update `firstPass` in the named file, and say
 * so in the commit message. It is never a reason to loosen the verifier.
 */
const recordings = await loadRecordings(join(__dirname, 'recorded'));

describe('recorded provider replies', () => {
  it.each(recordings.map(item => [item.file, item.recording] as const))('%s is verified as it was when recorded', (_file, recording) => {
    expect(replayRecording(recording)).toEqual(recording.firstPass);
  });

  // Breaks: nothing. It reports how much real-model evidence the suite holds,
  // so an empty folder reads as "none recorded yet" rather than as coverage.
  it('says how many recordings there are and how many predate the current answer prompt', () => {
    const stale = recordings.filter(item => item.recording.promptHash !== inboxAssistantPromptHash()).length;
    process.stdout.write(`[assistant-eval] ${recordings.length} recorded provider ${recordings.length === 1 ? 'reply' : 'replies'}`
      + `${recordings.length ? `, ${stale} recorded under an earlier answer prompt` : ' (none recorded yet: see docs/TESTING.md)'}\n`);
    expect(stale).toBeLessThanOrEqual(recordings.length);
  });
});
