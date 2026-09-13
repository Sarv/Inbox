// @vitest-environment happy-dom
// Warming means really splitting bodies, which the library does with the DOM.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isThreadSegmentWarm,
} from '../../../../../src/components/email-detail/chat-message-adapter';
import {
  PREWARM_CHUNK_SIZE,
  prewarmChunks,
  walkChunks,
  warmChatChunk,
} from '../../../../../src/components/email-detail/chat-prewarm';
import { populateCacheFromHtml } from '../../../../../src/services/image-cache';

import { email, ME } from './email-fixture';

// Real behaviour, observable: the prewarm has to fill the inline-image cache
// too, and the only way to see that from outside is to watch the call.
vi.mock('../../../../../src/services/image-cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/services/image-cache')>();
  return { ...actual, populateCacheFromHtml: vi.fn(actual.populateCacheFromHtml) };
});

/** A fresh id per mail — the segment cache is module-level and long-lived. */
let serial = 0;
const mail = (body: string) =>
  email({ id: `prewarm-${(serial += 1)}`, rawBody: body });

const BODY = '<p>Some content worth splitting.</p>';

beforeEach(() => {
  vi.mocked(populateCacheFromHtml).mockClear();
});

describe('prewarmChunks', () => {
  // Regression: the walk restarts from the top every time a body lands (a new
  // array is a new effect run). Without this filter a thread that streams its
  // bodies in re-splits everything already split, once per arrival — turning
  // the fix into the very cost it exists to remove.
  it('skips mails that are already split', () => {
    const done = mail(BODY);
    const todo = mail(BODY);
    const isWarm = (each: { id: string }) => each.id === done.id;

    expect(prewarmChunks([done, todo], isWarm)).toEqual([[todo]]);
  });

  // Regression: a mail whose body has not arrived has nothing to split, and
  // including it would spend a whole idle slice on nothing.
  it('skips mails whose body has not arrived', () => {
    const withBody = mail(BODY);
    const empty = email({ id: `prewarm-${(serial += 1)}`, rawBody: '', cleanBody: '' });

    expect(prewarmChunks([empty, withBody], () => false)).toEqual([[withBody]]);
  });

  // Regression: a slice runs to completion once started, so the chunk size IS
  // the longest the UI can be held. One chunk of everything is the freeze this
  // is meant to prevent, just moved off the click.
  it('never puts more than one chunk-size of mails in a slice', () => {
    const mails = Array.from({ length: PREWARM_CHUNK_SIZE * 2 + 1 }, () => mail(BODY));

    const chunks = prewarmChunks(mails, () => false);

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= PREWARM_CHUNK_SIZE)).toBe(true);
    expect(chunks.flat()).toEqual(mails);
  });

  it('has nothing to walk when every mail is warm', () => {
    expect(prewarmChunks([mail(BODY)], () => true)).toEqual([]);
    expect(prewarmChunks([], () => false)).toEqual([]);
  });
});

describe('warmChatChunk', () => {
  // Regression: the click that opens the chat view pays for the split. If the
  // warm does not leave it where the view looks, nothing about the click
  // changes and the thread still freezes.
  it('splits the chunk into the cache the chat view reads', () => {
    const each = mail(BODY);

    warmChatChunk([each], ME);

    expect(isThreadSegmentWarm(each)).toBe(true);
  });

  // Regression: inline images resolve through a second cache, filled by an
  // effect that is itself gated on the chat view being open — so it is the
  // other half of what the click pays for. Warming only the split leaves the
  // click doing a regex sweep of every raw body in the thread.
  it('registers the chunk’s inline images too', () => {
    const each = mail('<img src="data:image/png;base64,AAAA">');

    warmChatChunk([each], ME);

    expect(populateCacheFromHtml).toHaveBeenCalledWith(each.rawBody);
  });
});

describe('walkChunks', () => {
  /** A scheduler under the test's control: nothing runs until it says so. */
  function manualScheduler() {
    const queue: Array<() => void> = [];
    let cancelled = 0;
    const schedule = (slice: () => void) => {
      queue.push(slice);
      return () => {
        cancelled += 1;
      };
    };
    return {
      schedule,
      runNext: () => queue.shift()?.(),
      get pending() {
        return queue.length;
      },
      get cancelled() {
        return cancelled;
      },
    };
  }

  // Regression: the walk exists to hand the main thread back between slices.
  // Draining every chunk in one scheduled callback would be the same freeze,
  // just at a different moment.
  it('warms exactly one chunk per scheduled slice', () => {
    const scheduler = manualScheduler();
    const warmed: string[][] = [];
    const chunks = [[mail(BODY)], [mail(BODY)], [mail(BODY)]];

    walkChunks(chunks, (chunk) => warmed.push(chunk.map((each) => each.id)), scheduler.schedule);

    expect(warmed).toHaveLength(0);
    scheduler.runNext();
    expect(warmed).toHaveLength(1);
    scheduler.runNext();
    scheduler.runNext();
    expect(warmed.flat()).toEqual(chunks.flat().map((each) => each.id));
  });

  // Regression: the reader moved to another thread. A walk that keeps going
  // spends idle time splitting mail nobody is looking at and holds the main
  // thread behind the thread that IS open.
  it('stops on cancel and touches nothing further', () => {
    const scheduler = manualScheduler();
    const warmed: string[] = [];
    const chunks = [[mail(BODY)], [mail(BODY)]];

    const cancel = walkChunks(
      chunks,
      (chunk) => warmed.push(...chunk.map((each) => each.id)),
      scheduler.schedule,
    );
    scheduler.runNext();
    cancel();
    scheduler.runNext();

    expect(warmed).toEqual([chunks[0]![0]!.id]);
    expect(scheduler.cancelled).toBe(1);
  });

  // Regression: cancelling between a slice being scheduled and it firing is
  // the common case (the reader clicks the next mail). The already-queued
  // callback must not warm a thread that is no longer open.
  it('does not warm a slice that was queued before the cancel', () => {
    const scheduler = manualScheduler();
    const warmed: string[] = [];

    const cancel = walkChunks(
      [[mail(BODY)]],
      (chunk) => warmed.push(...chunk.map((each) => each.id)),
      scheduler.schedule,
    );
    cancel();
    scheduler.runNext();

    expect(warmed).toEqual([]);
  });

  // Regression: the walk must stop scheduling when it runs out, or it spins on
  // an undefined chunk for as long as the thread stays open.
  it('stops scheduling once the chunks run out', () => {
    const scheduler = manualScheduler();

    walkChunks([[mail(BODY)]], () => {}, scheduler.schedule);
    scheduler.runNext();

    expect(scheduler.pending).toBe(0);
  });
});
