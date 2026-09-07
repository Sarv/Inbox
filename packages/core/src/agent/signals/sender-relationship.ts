/**
 * Signal 4: Sender Relationship (Dynamic)
 *
 * Not just "customer/vendor" but dynamic hierarchy:
 * Senior colleague: they send, user replies fast
 * Junior colleague: user sends more, they reply fast
 * Active customer: recent frequent two-way
 * Churning customer: was active, gone silent 30+ days
 */

import type { ContactType } from '../../types/agent';

import type { SenderRelationshipSignal, SenderRelationship } from './types';

export function computeSenderRelationship(
  contactType: ContactType,
  inbound: number,
  outbound: number,
  avgReplyTimeSec: number | null,
  isInternalDomain: boolean,
  lastInteractionDaysAgo: number,
  totalFromSender: number,
  readRate: number,
  replyRate: number,
): SenderRelationshipSignal {
  // Directionality: -1 = they send to us mostly, +1 = we send to them mostly
  const total = Math.max(1, inbound + outbound);
  const directionality = (outbound - inbound) / total;

  let relationship: SenderRelationship;
  let value: number;
  let reasoning: string;

  // Internal domain → colleague variants
  if (isInternalDomain && contactType !== 'automated') {
    if (directionality < -0.3 && avgReplyTimeSec !== null && avgReplyTimeSec < 3600) {
      // They send more, user replies fast → senior/authority
      relationship = 'senior_colleague';
      value = 0.85;
      reasoning = `Senior colleague — user replies quickly (avg ${Math.round((avgReplyTimeSec || 0) / 60)}min)`;
    } else if (directionality > 0.3) {
      // User sends more → reports to user
      relationship = 'junior_colleague';
      value = 0.55;
      reasoning = 'Junior colleague — user initiates most conversations';
    } else {
      relationship = 'peer_colleague';
      value = 0.65;
      reasoning = 'Peer colleague — balanced communication';
    }
  }
  // Customer variants
  else if (contactType === 'existing_customer') {
    if (lastInteractionDaysAgo > 30) {
      relationship = 'churning_customer';
      value = 0.7; // Still important — might need re-engagement
      reasoning = `Customer gone silent (${Math.round(lastInteractionDaysAgo)}d) — may need attention`;
    } else {
      relationship = 'active_customer';
      value = 0.9;
      reasoning = `Active customer — last interaction ${Math.round(lastInteractionDaysAgo)}d ago`;
    }
  } else if (contactType === 'potential_customer') {
    relationship = 'new_prospect';
    value = 0.8;
    reasoning = 'New prospect — inbound inquiry';
  }
  // Vendor variants
  else if (contactType === 'vendor') {
    if (replyRate < 0.1 && readRate > 0.5) {
      relationship = 'transactional_vendor';
      value = 0.4;
      reasoning = 'Transactional vendor — user reads but rarely replies (invoices/receipts)';
    } else {
      relationship = 'marketing_vendor';
      value = 0.15;
      reasoning = 'Marketing/vendor — low engagement';
    }
  }
  // Automated / Newsletter
  else if (contactType === 'automated' || contactType === 'newsletter') {
    relationship = 'automated';
    value = 0.05;
    reasoning = `${contactType} sender — routine/automated`;
  }
  // Personal
  else if (contactType === 'personal') {
    relationship = 'personal';
    value = 0.6;
    reasoning = 'Personal contact';
  }
  // Unknown — use behavioral signals
  else {
    if (replyRate > 0.3 && totalFromSender >= 3) {
      relationship = 'unknown'; // But treat as valued
      value = 0.6;
      reasoning = `Unknown type but user engages (${Math.round(replyRate * 100)}% reply rate)`;
    } else if (readRate < 0.2 && totalFromSender >= 5) {
      relationship = 'marketing_vendor';
      value = 0.1;
      reasoning = `Unknown type, low read rate (${Math.round(readRate * 100)}%) — likely marketing`;
    } else {
      relationship = 'unknown';
      value = 0.4;
      reasoning = 'Unknown sender relationship';
    }
  }

  const confidence = Math.min(0.9, totalFromSender >= 10 ? 0.75 : totalFromSender >= 3 ? 0.5 : 0.2);

  return {
    value: Math.max(0, Math.min(1, value)),
    confidence,
    reasoning,
    relationship,
    directionality: Math.round(directionality * 100) / 100,
    lastInteractionDaysAgo: Math.round(lastInteractionDaysAgo),
  };
}
