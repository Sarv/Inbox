import { describe, it, expect } from 'vitest';

import {
  MIN_OBSERVATIONS,
  RECENCY_FRESH_DAYS,
  RECENCY_STALE_DAYS,
  applyObservation,
  emptyProfile,
  isVipSender,
  recencyScore,
  scoreRelationship,
  totalMessages,
  type SenderObservation,
  type SenderProfile,
} from '../../src/relationship';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function inbound(overrides: Partial<SenderObservation> = {}): SenderObservation {
  return { inbound: true, answered: false, starred: false, direct: true, at: NOW, ...overrides };
}

function outbound(at: number = NOW): SenderObservation {
  return { inbound: false, answered: false, starred: false, direct: false, at };
}

function profileOf(observations: SenderObservation[]): SenderProfile {
  return observations.reduce(applyObservation, emptyProfile(observations[0]?.at ?? NOW));
}

describe('applyObservation', () => {
  // Regression: inbound and outbound must move different counters. Crediting a
  // message you sent as one you received inflates the denominator of every
  // rate, so writing to someone would LOWER their score.
  it('counts an inbound message against received', () => {
    const profile = applyObservation(emptyProfile(NOW), inbound({ answered: true, starred: true }));
    expect(profile).toMatchObject({ received: 1, replied: 1, starred: 1, direct: 1, sent: 0 });
  });

  it('counts an outbound message against sent only', () => {
    const profile = applyObservation(emptyProfile(NOW), outbound());
    expect(profile).toMatchObject({ received: 0, replied: 0, sent: 1, direct: 0 });
  });

  // Regression: outbound messages carry no flags of the sender's, so an
  // answered/starred flag on one must never be credited.
  it('ignores inbound-only flags on an outbound message', () => {
    const profile = applyObservation(emptyProfile(NOW), {
      ...outbound(),
      answered: true,
      starred: true,
      direct: true,
    });
    expect(profile).toMatchObject({ replied: 0, starred: 0, direct: 0 });
  });

  // Regression: messages do not arrive in date order — a backfill of an old
  // folder lands after today's mail. Assigning rather than min/max-ing would
  // make an eight-year correspondent look brand new and reset their recency.
  it('keeps the earliest and latest times regardless of arrival order', () => {
    const profile = profileOf([inbound({ at: NOW }), inbound({ at: NOW - 400 * DAY }), inbound({ at: NOW - DAY })]);
    expect(profile.firstSeen).toBe(NOW - 400 * DAY);
    expect(profile.lastSeen).toBe(NOW);
  });
});

describe('recencyScore', () => {
  // Regression: the decay curve is what stops a correspondent from five years
  // ago outranking the person you are emailing today.
  it.each([
    ['today', 0, 1],
    ['at the freshness edge', RECENCY_FRESH_DAYS, 1],
    ['halfway through the decay', (RECENCY_FRESH_DAYS + RECENCY_STALE_DAYS) / 2, 0.5],
    ['at the stale edge', RECENCY_STALE_DAYS, 0],
    ['long stale', RECENCY_STALE_DAYS * 3, 0],
  ])('scores contact %s', (_label, daysAgo, expected) => {
    expect(recencyScore(NOW - daysAgo * DAY, NOW)).toBeCloseTo(expected, 5);
  });
});

describe('scoreRelationship', () => {
  // Regression: a sender with no traffic at all must score zero rather than
  // divide by zero and produce NaN, which compares false against every
  // threshold and silently disables the feature for that sender.
  it('scores an empty profile at zero', () => {
    expect(scoreRelationship(emptyProfile(NOW), NOW)).toBe(0);
  });

  // Regression: the headline case. Someone you correspond with must outrank a
  // newsletter that sends far more mail.
  it('ranks a correspondent above a high-volume newsletter', () => {
    const colleague = profileOf([
      ...Array.from({ length: 8 }, () => inbound({ answered: true })),
      ...Array.from({ length: 6 }, () => outbound()),
    ]);
    const newsletter = profileOf(Array.from({ length: 200 }, () => inbound({ direct: false })));

    expect(scoreRelationship(colleague, NOW)).toBeGreaterThan(scoreRelationship(newsletter, NOW));
  });

  // Regression: a bulk sender must stay well below any sensible threshold no
  // matter how much it sends — volume alone is not a relationship.
  it('keeps a newsletter below the default threshold', () => {
    const newsletter = profileOf(Array.from({ length: 500 }, () => inbound({ direct: false })));
    expect(scoreRelationship(newsletter, NOW)).toBeLessThan(0.6);
  });

  // Regression: someone you write to who rarely writes back is still important.
  // Scoring reciprocity only against received mail would rank them at zero.
  it('scores a person you write to without replies', () => {
    const profile = profileOf(Array.from({ length: 5 }, () => outbound()));
    expect(scoreRelationship(profile, NOW)).toBeGreaterThan(0.6);
  });

  // Regression: the score is a probability-like number the threshold setting is
  // expressed in. A value outside 0..1 makes the setting meaningless.
  it('stays within 0 and 1 for an extreme profile', () => {
    const profile = profileOf([
      ...Array.from({ length: 100 }, () => inbound({ answered: true, starred: true })),
      ...Array.from({ length: 100 }, () => outbound()),
    ]);
    const score = scoreRelationship(profile, NOW);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  // Regression: a relationship that ended must fade, or an old address keeps
  // marking mail important years later.
  it('scores a stale relationship below a live one', () => {
    const live = profileOf(Array.from({ length: 6 }, () => inbound({ answered: true })));
    const stale = profileOf(
      Array.from({ length: 6 }, () => inbound({ answered: true, at: NOW - RECENCY_STALE_DAYS * DAY }))
    );
    expect(scoreRelationship(stale, NOW)).toBeLessThan(scoreRelationship(live, NOW));
  });
});

describe('isVipSender', () => {
  // Regression: one message is a coin toss. Promoting on it means starring the
  // wrong mail on the strength of a single accident.
  it('refuses to promote on too little evidence', () => {
    const profile = profileOf([inbound({ answered: true, starred: true })]);
    expect(totalMessages(profile)).toBeLessThan(MIN_OBSERVATIONS);
    expect(isVipSender(profile, 0, NOW)).toBe(false);
  });

  // Regression: the threshold setting must actually gate promotion in both
  // directions, otherwise it is decorative.
  it('honours the threshold', () => {
    const profile = profileOf(Array.from({ length: 6 }, () => inbound({ answered: true })));
    expect(isVipSender(profile, 0.1, NOW)).toBe(true);
    expect(isVipSender(profile, 0.99, NOW)).toBe(false);
  });
});
