/**
 * What "this sender matters to me" means, as arithmetic.
 *
 * Everything here is pure: a profile in, a number out. The point is that the
 * score is explainable and testable — a black box deciding which mail gets
 * starred would be impossible to trust and worse to debug when it is wrong.
 */

/** What we remember about one correspondent. Counts only, never message content. */
export interface SenderProfile {
  /** Messages received FROM them. */
  received: number;
  /** Of those, the ones you answered (the IMAP \Answered flag). */
  replied: number;
  /** Messages you sent TO them. */
  sent: number;
  /** Of the received ones, how many you starred. */
  starred: number;
  /** Of the received ones, how many were addressed to you alone. */
  direct: number;
  /** UTC epoch ms of the earliest message we have seen either way. */
  firstSeen: number;
  /** UTC epoch ms of the most recent. */
  lastSeen: number;
}

/** One message, reduced to the facts that move a score. */
export interface SenderObservation {
  /** False for a message you sent to them. */
  inbound: boolean;
  /** Inbound only: the message carries the \Answered flag. */
  answered: boolean;
  /** Inbound only: you starred it. */
  starred: boolean;
  /** Inbound only: it was addressed to you alone, not to a list. */
  direct: boolean;
  /** UTC epoch ms. */
  at: number;
}

/**
 * Added to the denominator of every rate.
 *
 * Without it, one message you happened to answer reads as a 100% reply rate and
 * outranks a colleague with two hundred messages. One is not a pattern.
 */
const RATE_SMOOTHING = 1;

/** Messages beyond this add no further volume credit. */
const VOLUME_SATURATION = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Contact inside this window is fully recent. */
export const RECENCY_FRESH_DAYS = 30;

/** Contact older than this counts for nothing; between the two it decays linearly. */
export const RECENCY_STALE_DAYS = 180;

/**
 * Weights, summing to 1. Reciprocity dominates on purpose: the one thing that
 * separates a person who matters from a sender you merely tolerate is that you
 * write back to them.
 */
export const WEIGHTS = {
  reciprocity: 0.45,
  directRate: 0.15,
  starRate: 0.1,
  volume: 0.2,
  recency: 0.1,
} as const;

/**
 * The fewest messages either way before any score can promote a sender.
 * A relationship inferred from a single message is a coin toss, and the cost of
 * being wrong is starring the wrong mail.
 */
export const MIN_OBSERVATIONS = 3;

export function emptyProfile(at: number): SenderProfile {
  return { received: 0, replied: 0, sent: 0, starred: 0, direct: 0, firstSeen: at, lastSeen: at };
}

/** Total traffic either way — the evidence behind a profile. */
export function totalMessages(profile: SenderProfile): number {
  return profile.received + profile.sent;
}

/**
 * Fold one message into a profile, returning a new profile.
 *
 * `firstSeen`/`lastSeen` are min/max rather than assignments because messages
 * do not arrive in date order — a backfill of an old folder lands after today's
 * mail, and a plain assignment would make an eight-year correspondent look new.
 */
export function applyObservation(profile: SenderProfile, observation: SenderObservation): SenderProfile {
  const inbound = observation.inbound;
  return {
    received: profile.received + (inbound ? 1 : 0),
    replied: profile.replied + (inbound && observation.answered ? 1 : 0),
    sent: profile.sent + (inbound ? 0 : 1),
    starred: profile.starred + (inbound && observation.starred ? 1 : 0),
    direct: profile.direct + (inbound && observation.direct ? 1 : 0),
    firstSeen: Math.min(profile.firstSeen, observation.at),
    lastSeen: Math.max(profile.lastSeen, observation.at),
  };
}

/** Smoothed rate, clamped to 1. */
function rate(count: number, total: number): number {
  if (count <= 0) return 0;
  return Math.min(1, count / (Math.max(total, 0) + RATE_SMOOTHING));
}

/** 1 while contact is fresh, decaying linearly to 0 as it goes stale. */
export function recencyScore(lastSeen: number, now: number): number {
  const days = (now - lastSeen) / DAY_MS;
  if (days <= RECENCY_FRESH_DAYS) return 1;
  if (days >= RECENCY_STALE_DAYS) return 0;
  return 1 - (days - RECENCY_FRESH_DAYS) / (RECENCY_STALE_DAYS - RECENCY_FRESH_DAYS);
}

/**
 * Relationship strength in 0..1.
 *
 * Reciprocity counts BOTH halves of engagement — messages of theirs you
 * answered and messages you sent them unprompted — against how much they send
 * you. That is what separates a colleague from a mailing list you never
 * unsubscribed from, and it is why someone you write to who rarely writes back
 * still scores highly.
 */
export function scoreRelationship(profile: SenderProfile, now: number): number {
  const total = totalMessages(profile);
  if (total <= 0) return 0;

  const score =
    WEIGHTS.reciprocity * rate(profile.replied + profile.sent, profile.received) +
    WEIGHTS.directRate * rate(profile.direct, profile.received) +
    WEIGHTS.starRate * rate(profile.starred, profile.received) +
    (WEIGHTS.volume * Math.min(total, VOLUME_SATURATION)) / VOLUME_SATURATION +
    WEIGHTS.recency * recencyScore(profile.lastSeen, now);

  return Math.max(0, Math.min(1, score));
}

/**
 * Whether this sender should be treated as a VIP right now.
 *
 * Kept separate from the score so the score stays a pure measurement and the
 * policy — threshold, minimum evidence — can change without touching it.
 */
export function isVipSender(profile: SenderProfile, threshold: number, now: number): boolean {
  if (totalMessages(profile) < MIN_OBSERVATIONS) return false;
  return scoreRelationship(profile, now) >= threshold;
}
