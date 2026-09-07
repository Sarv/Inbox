/**
 * Behavior Analyzer
 *
 * Analyzes user action history to build a behavior profile.
 * This profile drives the agent's predictions and autonomous actions.
 */

import type {
  IAgentStorage,
  BehaviorProfile,
  UserActionType,
} from '../types/agent';
import type { EmailRecord } from '../types/models';

export interface BehaviorAnalyzerConfig {
  /** Minimum actions needed before making predictions */
  minActionsForPrediction: number;
  /** How far back to look for patterns (seconds) */
  analysisWindowSec: number;
  /** Minimum interactions with a sender to consider them for tiers */
  minSenderInteractions: number;
}

const DEFAULT_CONFIG: BehaviorAnalyzerConfig = {
  minActionsForPrediction: 50,
  analysisWindowSec: 90 * 86400, // 90 days
  minSenderInteractions: 5,
};

export class BehaviorAnalyzer {
  private config: BehaviorAnalyzerConfig;
  private cachedProfile: BehaviorProfile | null = null;
  private cacheExpiresAt: number = 0;
  private static CACHE_TTL_SEC = 300; // 5 minutes

  constructor(
    private storage: IAgentStorage,
    config?: Partial<BehaviorAnalyzerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Build or return cached behavior profile
   */
  async getProfile(): Promise<BehaviorProfile> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedProfile && now < this.cacheExpiresAt) {
      return this.cachedProfile;
    }

    const profile = await this.buildProfile();
    this.cachedProfile = profile;
    this.cacheExpiresAt = now + BehaviorAnalyzer.CACHE_TTL_SEC;
    return profile;
  }

  /**
   * Invalidate the cached profile (call after significant new data)
   */
  invalidateCache(): void {
    this.cachedProfile = null;
    this.cacheExpiresAt = 0;
  }

  /**
   * Build a complete behavior profile from action history
   */
  private async buildProfile(): Promise<BehaviorProfile> {
    const since = Math.floor(Date.now() / 1000) - this.config.analysisWindowSec;
    const stats = await this.storage.getActionStats(since);

    // Response patterns
    const replyCount = (stats.actionCounts['reply'] || 0) + (stats.actionCounts['reply_all'] || 0);
    const readCount = stats.actionCounts['read'] || 0;
    const responseRate = readCount > 0 ? replyCount / readCount : 0;

    // Average response time needs each reply's email received date, which
    // IAgentStorage can't provide (no email lookup) — computed downstream
    // in agent-repository. Kept at 0 here; don't fetch actions we can't use.
    const avgResponseTimeSec = 0;

    // Peak activity hours
    const peakHours = await this.computePeakHours();

    // Sender tiers
    const topReplied = await this.storage.getTopSendersByAction('reply', 50, since);
    const topDeleted = await this.storage.getTopSendersByAction('delete', 100, since);
    const topArchived = await this.storage.getTopSendersByAction('archive', 100, since);

    // VIP: senders user consistently replies to
    const vipSenders = topReplied
      .filter(s => s.count >= this.config.minSenderInteractions)
      .map(s => s.email);

    // Noise: senders user mostly deletes/archives and never replies to
    const repliedSet = new Set(topReplied.map(s => s.email));
    const noiseCandidates = [...topDeleted, ...topArchived]
      .filter(s => s.count >= this.config.minSenderInteractions && !repliedSet.has(s.email));
    const noiseSenders = [...new Set(noiseCandidates.map(s => s.email))];

    // Domain patterns
    const domainPatterns = await this.computeDomainPatterns(since);

    return {
      avgResponseTimeSec,
      responseRate: Math.round(responseRate * 100) / 100,
      peakActivityHours: peakHours,
      vipSenders,
      noiseSenders,
      domainPatterns,
      topicInterests: [], // Future: topic extraction from replied emails
      topicIgnores: [], // Future: topic extraction from deleted emails
      lastUpdated: Math.floor(Date.now() / 1000),
    };
  }

  /**
   * Get peak activity hours
   */
  private async computePeakHours(): Promise<number[]> {
    // Delegate to repo which has the SQL
    const recentActions = await this.storage.getRecentActions(1000);
    const hourCounts = new Map<number, number>();

    for (const action of recentActions) {
      const date = new Date(action.timestamp * 1000);
      const hour = date.getHours();
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    }

    return [...hourCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([hour]) => hour);
  }

  /**
   * Compute per-domain action patterns
   */
  private async computeDomainPatterns(since: number): Promise<BehaviorProfile['domainPatterns']> {
    const patterns: BehaviorProfile['domainPatterns'] = {};

    // Get top senders by volume
    const topRead = await this.storage.getTopSendersByAction('read', 50, since);

    for (const sender of topRead) {
      const domain = sender.email.split('@')[1];
      if (!domain || patterns[domain]) continue;

      const senderActions = await this.storage.getActionsBySender(sender.email, 200);
      if (senderActions.length < this.config.minSenderInteractions) continue;

      const counts: Record<string, number> = {};
      for (const action of senderActions) {
        counts[action.actionType] = (counts[action.actionType] || 0) + 1;
      }

      const total = Math.max(1, Object.values(counts).reduce((a, b) => a + b, 0));
      patterns[domain] = {
        readRate: (counts['read'] || 0) / total,
        replyRate: ((counts['reply'] || 0) + (counts['reply_all'] || 0)) / total,
        deleteRate: (counts['delete'] || 0) / total,
        archiveRate: (counts['archive'] || 0) / total,
        avgResponseTimeSec: 0, // Computed per-sender in repo
      };
    }

    return patterns;
  }

  /**
   * Predict the most likely user action for a new email
   */
  async predictAction(email: EmailRecord): Promise<{
    action: UserActionType;
    confidence: number;
    reasoning: string;
  } | null> {
    const profile = await this.getProfile();
    const sender = email.fromAddress?.toLowerCase();
    if (!sender) return null;

    // Check VIP list
    if (profile.vipSenders.includes(sender)) {
      return {
        action: 'read',
        confidence: 0.7,
        reasoning: `VIP sender — user consistently engages with ${sender}`,
      };
    }

    // Check noise list
    if (profile.noiseSenders.includes(sender)) {
      return {
        action: 'archive',
        confidence: 0.75,
        reasoning: `Noise sender — user typically archives/deletes from ${sender}`,
      };
    }

    // Check domain patterns
    const domain = sender.split('@')[1];
    const domainPattern = profile.domainPatterns[domain];
    if (domainPattern) {
      const actions: { action: UserActionType; rate: number }[] = [
        { action: 'reply', rate: domainPattern.replyRate },
        { action: 'archive', rate: domainPattern.archiveRate },
        { action: 'delete', rate: domainPattern.deleteRate },
      ];

      actions.sort((a, b) => b.rate - a.rate);
      const top = actions[0];

      if (top.rate > 0.4) {
        return {
          action: top.action,
          confidence: Math.round(top.rate * 0.8 * 100) / 100, // Discount for domain-level prediction
          reasoning: `Domain pattern: ${Math.round(top.rate * 100)}% of emails from ${domain} get ${top.action}d`,
        };
      }
    }

    return null; // Not enough data to predict
  }

  /**
   * Check if we have enough data to make reliable predictions
   */
  async hasEnoughData(): Promise<boolean> {
    const stats = await this.storage.getActionStats();
    return stats.totalActions >= this.config.minActionsForPrediction;
  }
}
