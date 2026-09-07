/**
 * EmailAgent — Autonomous Email Agent
 *
 * The central orchestrator that:
 * 1. Observes user behavior via action logs
 * 2. Learns patterns via BehaviorAnalyzer
 * 3. Makes predictions and proposes actions
 * 4. Executes approved/high-confidence actions autonomously
 * 5. Continuously improves via feedback loop
 */

import type {
  IAgentStorage,
  AgentConfig,
  AgentDecision,
  AgentProposal,
  UserActionType,
  BehaviorProfile,
} from '../types/agent';
import type { ILLMProvider } from '../types/llm';
import type { EmailRecord } from '../types/models';
import { logger } from '../utils/logger';

import { BehaviorAnalyzer } from './behavior-analyzer';
import { ReplyStyleAnalyzer, type ReplyStyleProfile } from './reply-style-analyzer';


export interface EmailAgentDeps {
  storage: IAgentStorage;
  llm?: ILLMProvider;
  /** Execute an action on an email (e.g., archive, delete, mark read) */
  executeAction: (emailId: string, action: UserActionType, value?: string) => Promise<void>;
  /** Get sent emails for style analysis */
  getSentEmails: (limit: number) => Promise<EmailRecord[]>;
}

const DEFAULT_CONFIG: AgentConfig = {
  enabled: true,
  autoActThreshold: 0.85,
  suggestThreshold: 0.5,
  autoTriage: false,
  autoRead: false,
  draftReplies: true,
  autoReply: false,
  autoStar: true,
  autoPrioritize: true,
  neverAutoDeleteFrom: [],
  neverAutoReplyTo: [],
  requireApprovalForNew: true,
  maxAutoActionsPerHour: 50,
  searchWebEnabled: false,
  testMode: false,
};

export class EmailAgent {
  private config: AgentConfig;
  private behaviorAnalyzer: BehaviorAnalyzer;
  private replyStyleAnalyzer: ReplyStyleAnalyzer;
  private autoActionsThisHour: number = 0;
  private lastHourReset: number = 0;
  private replyStyleProfile: ReplyStyleProfile | null = null;

  constructor(
    private deps: EmailAgentDeps,
    config?: Partial<AgentConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.behaviorAnalyzer = new BehaviorAnalyzer(deps.storage);
    this.replyStyleAnalyzer = new ReplyStyleAnalyzer();
  }

  /**
   * Update agent configuration
   */
  updateConfig(updates: Partial<AgentConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Get current configuration
   */
  getConfig(): AgentConfig {
    return { ...this.config };
  }

  /**
   * Process a new incoming email — the main entry point
   * Returns a proposal if the agent wants to take action
   */
  async processNewEmail(email: EmailRecord): Promise<AgentProposal | null> {
    if (!this.config.enabled) return null;

    // Check rate limit
    if (!this.checkRateLimit()) {
      logger.warn('[EmailAgent] Rate limit reached, skipping');
      return null;
    }

    try {
      // 1. Predict action from behavior
      const prediction = await this.behaviorAnalyzer.predictAction(email);
      if (!prediction) return null;

      // 2. Check safety constraints
      if (!this.isSafeToAct(email, prediction.action)) {
        return null;
      }

      // 3. Determine if we should auto-act or suggest
      const now = Math.floor(Date.now() / 1000);

      if (prediction.confidence >= this.config.autoActThreshold && this.canAutoAct(prediction.action)) {
        // High confidence — execute automatically
        await this.executeAutoAction(email, prediction.action, prediction.reasoning);
        return null; // No proposal needed, already executed
      }

      if (prediction.confidence >= this.config.suggestThreshold) {
        // Medium confidence — propose to user
        const proposal = this.createProposal(email, prediction);

        // Save decision record for learning
        await this.deps.storage.saveDecision({
          id: `dec-${now}-${Math.random().toString(36).substr(2, 9)}`,
          emailId: email.id,
          threadId: email.threadId || null,
          senderAddress: email.fromAddress?.toLowerCase() || null,
          proposedAction: prediction.action,
          proposedValue: null,
          confidence: prediction.confidence,
          reasoning: prediction.reasoning,
          status: 'pending',
          actualAction: null,
          userFeedback: null,
          proposedAt: now,
          resolvedAt: null,
          createdAt: now,
        });

        return proposal;
      }

      return null;
    } catch (error) {
      logger.error('[EmailAgent] Error processing email:', error);
      return null;
    }
  }

  /**
   * Process a batch of new emails (e.g., after sync)
   */
  async processBatch(emails: EmailRecord[]): Promise<AgentProposal[]> {
    if (!this.config.enabled) return [];

    const proposals: AgentProposal[] = [];
    for (const email of emails) {
      const proposal = await this.processNewEmail(email);
      if (proposal) {
        proposals.push(proposal);
      }
    }
    return proposals;
  }

  /**
   * Handle user's response to a proposal
   */
  async resolveProposal(
    decisionId: string,
    approved: boolean,
    actualAction?: UserActionType,
    feedback?: string,
  ): Promise<void> {
    const status = approved ? 'approved' : 'rejected';
    await this.deps.storage.updateDecisionStatus(
      decisionId,
      status,
      actualAction || null,
      feedback || null,
    );

    // Invalidate behavior cache so next predictions use updated data
    this.behaviorAnalyzer.invalidateCache();
  }

  /**
   * Get the user's behavior profile
   */
  async getBehaviorProfile(): Promise<BehaviorProfile> {
    return this.behaviorAnalyzer.getProfile();
  }

  /**
   * Get reply style profile (builds if needed)
   */
  async getReplyStyleProfile(): Promise<ReplyStyleProfile> {
    if (this.replyStyleProfile) return this.replyStyleProfile;

    const sentEmails = await this.deps.getSentEmails(100);
    this.replyStyleProfile = await this.replyStyleAnalyzer.analyzeStyle(sentEmails);
    return this.replyStyleProfile;
  }

  /**
   * Generate a reply draft for an email
   */
  async generateReplyDraft(
    email: EmailRecord,
    threadHistory: EmailRecord[],
  ): Promise<{ subject: string; body: string; confidence: number } | null> {
    if (!this.deps.llm) {
      logger.warn('[EmailAgent] No LLM provider configured, cannot generate reply');
      return null;
    }

    const profile = await this.getReplyStyleProfile();
    return this.replyStyleAnalyzer.generateReply(email, threadHistory, profile, this.deps.llm);
  }

  /**
   * Get agent accuracy metrics
   */
  async getAccuracy(days?: number): Promise<{
    total: number;
    approved: number;
    rejected: number;
    accuracy: number;
  }> {
    const since = days ? Math.floor(Date.now() / 1000) - (days * 86400) : undefined;
    return this.deps.storage.getDecisionAccuracy(since);
  }

  /**
   * Get pending proposals awaiting user action
   */
  async getPendingProposals(): Promise<AgentDecision[]> {
    return this.deps.storage.getPendingDecisions();
  }

  /**
   * Check if agent is ready (has enough data to make predictions)
   */
  async isReady(): Promise<boolean> {
    return this.behaviorAnalyzer.hasEnoughData();
  }

  // ========== Private Methods ==========

  private async executeAutoAction(
    email: EmailRecord,
    action: UserActionType,
    reasoning: string,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);

    try {
      await this.deps.executeAction(email.id, action);
      this.autoActionsThisHour++;

      // Log the auto-executed decision
      await this.deps.storage.saveDecision({
        id: `dec-${now}-${Math.random().toString(36).substr(2, 9)}`,
        emailId: email.id,
        threadId: email.threadId || null,
        senderAddress: email.fromAddress?.toLowerCase() || null,
        proposedAction: action,
        proposedValue: null,
        confidence: 1.0,
        reasoning: `[AUTO] ${reasoning}`,
        status: 'auto',
        actualAction: action,
        userFeedback: null,
        proposedAt: now,
        resolvedAt: now,
        createdAt: now,
      });

      logger.info(`[EmailAgent] Auto-executed ${action} on email ${email.id}`);
    } catch (error) {
      logger.error(`[EmailAgent] Failed to auto-execute ${action}:`, error);
    }
  }

  private createProposal(
    email: EmailRecord,
    prediction: { action: UserActionType; confidence: number; reasoning: string },
  ): AgentProposal {
    const now = Math.floor(Date.now() / 1000);

    const actionLabels: Record<string, string> = {
      archive: 'Archive this email',
      delete: 'Move to trash',
      read: 'Mark as read',
      spam: 'Mark as spam',
      star: 'Star this email',
      reply: 'Draft a reply',
      important: 'Mark as important',
    };

    return {
      id: `prop-${now}-${Math.random().toString(36).substr(2, 9)}`,
      emailId: email.id,
      threadId: email.threadId || null,
      action: prediction.action,
      value: null,
      confidence: prediction.confidence,
      reasoning: prediction.reasoning,
      previewText: `${actionLabels[prediction.action] || prediction.action}: "${email.subject || 'No subject'}" from ${email.fromName || email.fromAddress}`,
      proposedAt: now,
      expiresAt: now + 3600, // 1 hour expiry
    };
  }

  private isSafeToAct(email: EmailRecord, action: UserActionType): boolean {
    const sender = email.fromAddress?.toLowerCase() || '';
    const domain = sender.split('@')[1] || '';

    // Never auto-delete from protected senders
    if (['delete', 'spam'].includes(action)) {
      if (this.config.neverAutoDeleteFrom.some(s =>
        sender.includes(s.toLowerCase()) || domain.includes(s.toLowerCase())
      )) {
        return false;
      }
    }

    // Never auto-reply to protected addresses
    if (['reply', 'reply_all'].includes(action)) {
      if (this.config.neverAutoReplyTo.some(s =>
        sender.includes(s.toLowerCase()) || domain.includes(s.toLowerCase())
      )) {
        return false;
      }
    }

    // Require approval for new senders
    if (this.config.requireApprovalForNew) {
      // New senders always get proposals, not auto-actions
      // The BehaviorAnalyzer already handles this by returning null for unknown senders
    }

    return true;
  }

  private canAutoAct(action: UserActionType): boolean {
    switch (action) {
      case 'archive':
        return this.config.autoTriage;
      case 'read':
        return this.config.autoRead;
      case 'reply':
      case 'reply_all':
        return this.config.autoReply;
      case 'important':
      case 'star':
        return this.config.autoStar;
      default:
        return false;
    }
  }

  private checkRateLimit(): boolean {
    const now = Math.floor(Date.now() / 1000);
    const hourStart = Math.floor(now / 3600) * 3600;

    if (hourStart !== this.lastHourReset) {
      this.lastHourReset = hourStart;
      this.autoActionsThisHour = 0;
    }

    return this.autoActionsThisHour < this.config.maxAutoActionsPerHour;
  }
}
