/**
 * What stops a stranger's code spending the main process's time. Too loose and main stalls;
 * too tight and a healthy extension is killed in the middle of a reader's first sync, which
 * is what this replaced: the real vip-scoring, killed at mail 3,331.
 */

import { describe, expect, it } from 'vitest';

import {
  messageBytes,
  MAX_MESSAGE_BYTES,
  createFloodBudget,
  FLOOD_BASE_MESSAGES,
  FLOOD_BYTES,
  FLOOD_MESSAGES_PER_CALL,
  FLOOD_WINDOW_MS,
} from '../../../src/extensions/runtime/flood-budget';

const small = { type: 'x' };

describe('flood budget', () => {
  // The extension's own doing: a loop posting at full speed.
  it('stops unsolicited messages past the base allowance', () => {
    const budget = createFloodBudget(() => 0);
    for (let i = 0; i < FLOOD_BASE_MESSAGES; i += 1) expect(budget.noteMessage(small, false)).toBe('ok');
    expect(budget.noteMessage(small, false)).toBe('too-many');
  });

  // Main's own doing: however many replies arrive, it asked for each.
  it('never counts a reply main asked for against the message limit', () => {
    const budget = createFloodBudget(() => 0);
    for (let i = 0; i < FLOOD_BASE_MESSAGES * 3; i += 1) expect(budget.noteMessage(small, true)).toBe('ok');
  });

  // A workflow that reads its storage per message makes host calls at the rate mail arrives.
  it('allows more for each call main made', () => {
    const budget = createFloodBudget(() => 0);
    for (let i = 0; i < 1_000; i += 1) budget.noteCall();
    const allowance = FLOOD_BASE_MESSAGES + 1_000 * FLOOD_MESSAGES_PER_CALL;
    for (let i = 0; i < allowance; i += 1) expect(budget.noteMessage(small, false)).toBe('ok');
    expect(budget.noteMessage(small, false)).toBe('too-many');
  });

  // A rate, not a lifetime total: a busy extension over a long day must never add up to it.
  it('starts again each window', () => {
    let time = 0;
    const budget = createFloodBudget(() => time);
    for (let i = 0; i < FLOOD_BASE_MESSAGES; i += 1) budget.noteMessage(small, false);
    time += FLOOD_WINDOW_MS;
    expect(budget.noteMessage(small, false)).toBe('ok');
  });

  // Replies count here: a workflow answering with 50 MB strings stalls main just the same.
  it('stops bytes past the limit, solicited or not', () => {
    const budget = createFloodBudget(() => 0);
    const large = { value: 'x'.repeat(MAX_MESSAGE_BYTES - 1000) };
    const fit = Math.floor(FLOOD_BYTES / (MAX_MESSAGE_BYTES - 1000));
    for (let i = 0; i < fit; i += 1) expect(budget.noteMessage(large, true)).toBe('ok');
    expect(budget.noteMessage(large, true)).toBe('too-large');
  });

  it('starts bytes again each window too', () => {
    let time = 0;
    const budget = createFloodBudget(() => time);
    const large = { value: 'x'.repeat(MAX_MESSAGE_BYTES - 1000) };
    const fit = Math.floor(FLOOD_BYTES / (MAX_MESSAGE_BYTES - 1000));
    for (let i = 0; i < fit; i += 1) budget.noteMessage(large, true);
    time += FLOOD_WINDOW_MS;
    expect(budget.noteMessage(large, true)).toBe('ok');
  });

  // Measured: a 300 MB string reaching JSON.stringify in main ends the whole app, with no
  // exception to catch, and it took one message. So one is enough to stop it, reply or not.
  it.each([
    ['unsolicited', false],
    ['a reply', true],
  ])('stops a single message over the size limit: %s', (_name, solicited) => {
    const budget = createFloodBudget(() => 0);
    expect(budget.noteMessage({ value: 'x'.repeat(MAX_MESSAGE_BYTES + 1) }, solicited)).toBe('too-large');
  });

  // The limit and the budget are one check each: the first must stay below the second, or
  // the bigger of the two is the only one that ever fires.
  it('allows several largest messages in a window', () => {
    expect(FLOOD_BYTES / MAX_MESSAGE_BYTES).toBeGreaterThanOrEqual(4);
  });
});

describe('messageBytes', () => {
  // Each shape a flood could come in, or hiding bytes in one of them would be free.
  it.each([
    ['a string', 'x'.repeat(1000), 1000],
    ['a nested string', { a: { b: { c: 'x'.repeat(1000) } } }, 1000],
    ['bytes', new Uint8Array(1000), 1000],
    ['an ArrayBuffer', new ArrayBuffer(1000), 1000],
    ['a string in an array', [['x'.repeat(1000)]], 1000],
    ['a long array of strings', new Array(100_000).fill('xxxxxxxxxx'), 1_000_000],
    ['a Map value', new Map([['k', 'x'.repeat(1000)]]), 1000],
    ['a Map key', new Map([['x'.repeat(1000), 1]]), 1000],
    ['a Set', new Set(['x'.repeat(1000)]), 1000],
    ['a RegExp', new RegExp('x'.repeat(1000)), 1000],
    ['an Error message, which is not enumerable', new Error('x'.repeat(1000)), 1000],
    ['an object key', { ['x'.repeat(1000)]: 1 }, 1000],
  ])('sees %s', (_name, message, atLeast) => {
    expect(messageBytes(message)).toBeGreaterThanOrEqual(atLeast);
  });

  it('is unbothered by what is not there', () => {
    expect(messageBytes(null)).toBe(0);
    expect(messageBytes(undefined)).toBe(0);
    expect(messageBytes(42)).toBe(0);
  });

  // It used to look at 256 values and estimate the rest, which was fine for counting a
  // flood. It is not for the size limit: one hidden string is all the crash needs.
  it.each([
    ['past the first few of an array', () => [...new Array(5000).fill(1), 'x'.repeat(1_000_000)]],
    ['past the first few keys', () => {
      const wide: Record<string, unknown> = Object.fromEntries(Array.from({ length: 5000 }, (_v, i) => [`k${i}`, i]));
      wide.z = 'x'.repeat(1_000_000);
      return wide;
    }],
    ['past hundreds of small objects', () => [...Array.from({ length: 5000 }, () => ({ a: 1 })), { deep: ['x'.repeat(1_000_000)] }]],
    ['deep down', () => {
      let nested: unknown = 'x'.repeat(1_000_000);
      for (let i = 0; i < 100_000; i += 1) nested = { nested };
      return nested;
    }],
  ])('finds a string hidden %s', (_name, build) => {
    expect(messageBytes(build())).toBeGreaterThanOrEqual(1_000_000);
  });

  // Structured clone keeps cycles, so a message can be one. A walk that loops forever on
  // it would hang main with a message of a few bytes.
  it('finishes on a cycle, and does not count it twice', () => {
    const cyclic: Record<string, unknown> = { text: 'x'.repeat(1000) };
    cyclic.self = cyclic;
    cyclic.list = [cyclic, cyclic];

    const bytes = messageBytes(cyclic);

    expect(bytes).toBeGreaterThanOrEqual(1000);
    expect(bytes).toBeLessThan(2000);
  });

  // Measuring must not itself be the flood. `new Array(4294967295)` costs a few bytes to
  // send and four billion iterations to walk naively. Breaks: the walk reads every element
  // instead of stopping once the limit is passed. It counts the reads rather than timing
  // them, so a loaded runner cannot fail it, and a regression fails before the four
  // billion holes below are ever walked.
  it('stops at the limit instead of walking the rest', () => {
    let reads = 0;
    const strings = new Proxy(Array.from({ length: 10_000 }, () => 'x'.repeat(1_000)), {
      get(target, key, receiver) {
        if (typeof key === 'string' && Number.isInteger(Number(key))) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    // 80 KB of slots, then ~120 of the 1 KB strings pass 200 KB: the other ~9,900 are never read.
    expect(messageBytes(strings, 200_000)).toBeGreaterThan(200_000);
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(200);

    expect(messageBytes(new Array(4_294_967_295))).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(messageBytes(new Array(20_000_000).fill(0))).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(messageBytes(['x'.repeat(100), { a: 'x'.repeat(100) }], 50)).toBeGreaterThan(50);
  });

  it('counts what it can stop at inside a Map, a Set and an object too', () => {
    const big = 'x'.repeat(1000);
    expect(messageBytes(new Map([['a', big], ['b', big], ['c', big]]), 500)).toBeLessThan(2500);
    expect(messageBytes(new Set([big, `${big}1`, `${big}2`]), 500)).toBeLessThan(2500);
    expect(messageBytes({ a: big, b: big, c: big }, 500)).toBeLessThan(2500);
  });
});
