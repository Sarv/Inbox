import { describe, expect, it } from 'vitest';

import { createByteBudget } from '../../../src/utils/byte-budget';

// What breaks if this file fails: the app freezes, and only on the mailboxes big
// enough to matter. Both background body passes bound their transaction with this
// budget, and every failure mode here is a main-thread stall rather than an
// error —
//
//  * A budget that admits too much puts megabytes into one transaction. That is
//    the bug this helper was extracted to fix: 50-row chunks over ~356 KB bodies
//    froze the UI for 851 ms per commit, 524 times in a row.
//  * A budget that refuses the FIRST item cannot make progress on a body larger
//    than the budget. The 21 MB body parks at the head of the cursor and every
//    row behind it stalls forever — a pass that reports "0 changed" and never
//    finishes.
//  * A budget whose accumulator absorbs a non-number silently becomes infinite,
//    which is the first failure mode wearing the mask of a working budget.

describe('createByteBudget', () => {
  it('admits items until the limit is reached', () => {
    const budget = createByteBudget(100);

    expect(budget.admits(40)).toBe(true);
    budget.spend(40);
    expect(budget.admits(60)).toBe(true); // exactly fills it
    budget.spend(60);

    expect(budget.spent).toBe(100);
    expect(budget.items).toBe(2);
    expect(budget.admits(1)).toBe(false);
  });

  // The at-least-one-item rule. Without it the pass cannot move a body bigger
  // than a chunk, and those are exactly the bodies costing the most to leave.
  it('admits the first item however far over the limit it is', () => {
    const budget = createByteBudget(1024);

    expect(budget.admits(21 * 1024 * 1024)).toBe(true);
    budget.spend(21 * 1024 * 1024);

    // ...and nothing after it.
    expect(budget.admits(1)).toBe(false);
    expect(budget.isExhausted()).toBe(true);
  });

  // An item that would cross the limit is refused rather than admitted-and-then-
  // regretted: `admits` is asked BEFORE the work by callers who know the size up
  // front (the inline-image pass reads LENGTH() in its selecting query).
  it('refuses an item that would overshoot, without consuming it', () => {
    const budget = createByteBudget(100);
    budget.spend(90);

    expect(budget.admits(11)).toBe(false);
    expect(budget.spent).toBe(90); // asking is not spending
    expect(budget.admits(10)).toBe(true);
  });

  // The other calling convention: the body-relocation pass only learns a row's
  // size from the RETURNING clause of the write, so it spends AFTER the row and
  // stops on isExhausted. That order is what gives it the at-least-one rule.
  it('reports exhaustion only once the limit is met', () => {
    const budget = createByteBudget(100);

    expect(budget.isExhausted()).toBe(false);
    budget.spend(99);
    expect(budget.isExhausted()).toBe(false);
    budget.spend(1);
    expect(budget.isExhausted()).toBe(true);
  });

  // SQLite hands back NULL for LENGTH() of a NULL column, and `undefined` when a
  // RETURNING row is missing entirely (a row deleted mid-transaction). Either
  // one added to the accumulator as-is makes `spent` NaN, NaN >= limit is false,
  // and the budget silently never exhausts — an unbounded transaction wearing
  // the mask of a bounded one.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
    ['negative', -500],
  ])('treats a %s size as zero rather than poisoning the accumulator', (_label, size) => {
    const budget = createByteBudget(100);

    budget.spend(size as unknown as number);
    budget.spend(100);

    expect(budget.spent).toBe(100);
    expect(budget.items).toBe(2); // the row still happened, and still counts
    expect(budget.isExhausted()).toBe(true);
  });

  // A zero budget must still take one item, or a caller that computes its budget
  // from a setting and lands on 0 stops making progress entirely.
  it('still admits one item on a zero budget', () => {
    const budget = createByteBudget(0);

    expect(budget.admits(5_000)).toBe(true);
    budget.spend(5_000);
    expect(budget.admits(1)).toBe(false);
  });

  it('starts empty', () => {
    const budget = createByteBudget(100);
    expect(budget.spent).toBe(0);
    expect(budget.items).toBe(0);
    expect(budget.isExhausted()).toBe(false);
  });
});
