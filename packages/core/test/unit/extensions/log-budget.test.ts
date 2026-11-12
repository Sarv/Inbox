/**
 * The guard on how fast an extension can write to the app log, which is a
 * synchronous write on the main thread. Gone, a loop in an extension stalls the
 * process syncing the user's mail.
 */

import { describe, expect, it } from 'vitest';

import {
  createLogBudget,
  LOG_LINES_PER_WINDOW,
  LOG_WINDOW_MS,
} from '../../../src/extensions/runtime/log-budget';

describe('log budget', () => {
  // An extension logging normally must never meet it.
  it('allows lines up to the limit and refuses the rest', () => {
    let time = 0;
    const budget = createLogBudget(() => time);
    for (let i = 0; i < LOG_LINES_PER_WINDOW; i += 1) expect(budget.take().allowed).toBe(true);
    expect(budget.take().allowed).toBe(false);
    time += LOG_WINDOW_MS - 1;
    expect(budget.take().allowed).toBe(false);
  });

  // Silence would look like an extension that stopped logging: the drop has to be
  // said, once, when the next window opens.
  it('reports what it dropped once, then starts again', () => {
    let time = 0;
    const budget = createLogBudget(() => time);
    for (let i = 0; i < LOG_LINES_PER_WINDOW + 7; i += 1) budget.take();

    time += LOG_WINDOW_MS;
    expect(budget.take()).toEqual({ allowed: true, dropped: 7 });
    expect(budget.take()).toEqual({ allowed: true, dropped: 0 });
  });
});
