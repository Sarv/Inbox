/**
 * Agent IPC Handlers
 *
 * Handles: action logging, agent decisions, behavior queries, sender metrics.
 * These handlers power the Email Agent's learning and autonomous capabilities.
 */

import type { UserActionType, ActionSource } from '@sarvinbox/core';
import { createLogger } from '@sarvinbox/core';
import { cleanBodyExpression } from '@sarvinbox/storage-node';
import { ipcMain } from 'electron';

import { resolveAccountEmail } from '../services/accounts-registry';
import { saveAgentConfig, loadAgentConfig } from '../services/agent-config-store';
import { getIntelligence, getUnifiedPipeline, setPipelineUserProfile, getPipelineAIConfig } from '../services/unified-pipeline-service';
import { requireStorage, getSyncEngine, getAllAccountRuntimes, getCurrentAccountId } from '../shared';
// Static imports (NOT require()): the app bundles into a single dist-electron/
// main.js, so a runtime require('../services/...') has no file to resolve and
// throws "Cannot find module" — which silently broke every agent config/enable
// handler. esbuild bundles static imports correctly.
// Static import (not require()) so esbuild reliably bundles the CURRENT
// agent-config-store — a dynamic require here was picking up a stale copy.

const logger = createLogger('agent-handlers');

/**
 * Generate a unique ID for action log entries
 */
function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Get the agent repository from storage
 */
function getAgentRepo() {
  const storage = requireStorage();
  const repos = (storage as any).getRepositories();
  return repos.agent;
}

// The agent's backfill + contact-classification + sender-memory build are heavy
// SYNCHRONOUS better-sqlite3 passes (seconds on a large mailbox). They must NOT
// run inline in the agent:setConfig IPC — that froze the main event loop at
// startup and stalled the connect/account IPC (the renderer then flashed "No
// account connected"). Debounce + defer: coalesce the burst of setConfig pushes
// the renderer fires on boot / AI reconfig into ONE run a few seconds later, once
// the UI and account are already up. Best-effort; the data is additive/idempotent.
let agentLearnTimer: NodeJS.Timeout | null = null;
let agentLearnEmail = '';
const AGENT_LEARN_DELAY_MS = 4000;

function scheduleAgentLearning(userEmail: string): void {
  agentLearnEmail = userEmail;
  if (agentLearnTimer) return; // a run is already pending — coalesce into it
  agentLearnTimer = setTimeout(() => {
    agentLearnTimer = null;
    const email = agentLearnEmail;
    if (!email) return;
    try {
      const agentRepo = getAgentRepo();
      const bf = agentRepo.backfillFromHistory();
      const cl = agentRepo.autoClassifyContacts(email);
      const m = agentRepo.buildAllSenderMemories(email);
      logger.info(`[Agent] Learning (deferred): +${bf.actionsCreated} actions, ${cl} contacts, ${m} sender memories`);
    } catch (e) {
      logger.warn('[Agent] deferred learning failed:', (e as Error).message);
    }
  }, AGENT_LEARN_DELAY_MS);
  agentLearnTimer.unref?.();
}

/**
 * One-time (per account) backfill: when AI Assist is ON, the auto-pipeline only
 * processes agent_status='pending' mail — but a mailbox "processed" while AI was
 * OFF is all 'done' with no categories and would never auto-categorize. Re-queue
 * each account's recent Inbox window to 'pending' ONCE so the pipeline picks it
 * up. Tracked PER ACCOUNT (not a single global flag) so accounts that come
 * online later — e.g. a background account that finishes connecting after the
 * boot enable — still get backfilled on a subsequent setConfig.
 */
function runBackfillForNewAccounts(limit: number): void {
  const done: string[] = (() => {
    const v = loadAgentConfig().backfillRequeuedAccounts;
    return Array.isArray(v) ? (v as string[]) : [];
  })();
  const seen = new Set<any>();
  const targets: Array<[string, any]> = [];
  try {
    const active = requireStorage();
    if (active) { targets.push([getCurrentAccountId() ?? 'default', active]); seen.add(active); }
  } catch { /* no active storage yet */ }
  for (const [id, rt] of getAllAccountRuntimes()) {
    if (rt.storage && !seen.has(rt.storage)) { targets.push([id, rt.storage]); seen.add(rt.storage); }
  }

  let changed = false;
  for (const [id, store] of targets) {
    if (done.includes(id)) continue;
    try {
      const n = (store as any).getRepositories().agent.requeueRecentInboxForAgent(limit);
      done.push(id);
      changed = true;
      logger.info(`[Agent] AI Assist on — re-queued ${n} existing Inbox emails for account ${id}`);
    } catch (e) {
      logger.error(`[Agent] backfill re-queue failed for account ${id}:`, e);
    }
  }
  if (changed) saveAgentConfig({ backfillRequeuedAccounts: done });
}

/**
 * Log a user action — called from email-handlers or renderer process
 * This is the central entry point for all behavior tracking.
 * It writes to user_action_log (timeline) AND updates sender_stats (aggregates)
 * via the existing upsertSenderStats — no duplicate data.
 */
export async function logUserAction(
  emailId: string,
  actionType: UserActionType,
  options: {
    threadId?: string | null;
    actionValue?: string | null;
    source?: ActionSource;
    senderAddress?: string | null;
  } = {},
): Promise<void> {
  try {
    const agentRepo = getAgentRepo();
    await agentRepo.logAction({
      id: generateId('act'),
      emailId,
      threadId: options.threadId || null,
      actionType,
      actionValue: options.actionValue || null,
      source: options.source || 'user',
      senderAddress: options.senderAddress?.toLowerCase() || null,
      timestamp: Math.floor(Date.now() / 1000),
      createdAt: Math.floor(Date.now() / 1000),
    });

    // Also update existing sender_stats aggregates (reuses existing system, no duplication)
    const sender = options.senderAddress;
    if (sender) {
      const storage = requireStorage();
      const statsUpdate: Record<string, number> = {};
      if (actionType === 'read') statsUpdate.readCount = 1;
      else if (actionType === 'delete') statsUpdate.deletedCount = 1;
      else if (actionType === 'reply' || actionType === 'reply_all') statsUpdate.repliedCount = 1;

      if (Object.keys(statsUpdate).length > 0) {
        (storage as any).upsertSenderStats({ email: sender, ...statsUpdate }).catch(() => {});
      }
    }
  } catch (error) {
    // Don't let action logging errors break the main flow
    logger.error('[Agent] Failed to log action:', error);
  }
}

/**
 * Helper: resolve sender address from email ID
 */
async function getSenderForEmail(emailId: string): Promise<string | null> {
  try {
    const storage = requireStorage();
    const email = await storage.getEmail(emailId);
    return email?.fromAddress?.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function registerAgentHandlers(): void {
  // ========== Action Logging (from renderer) ==========

  /**
   * Log a user action from the renderer process
   */
  ipcMain.handle('agent:logAction', async (_event, emailId: string, actionType: UserActionType, options?: {
    threadId?: string;
    actionValue?: string;
    source?: ActionSource;
    senderAddress?: string;
  }) => {
    try {
      // Auto-resolve sender if not provided
      let senderAddress = options?.senderAddress;
      if (!senderAddress) {
        senderAddress = await getSenderForEmail(emailId) || undefined;
      }

      await logUserAction(emailId, actionType, {
        ...options,
        senderAddress,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Log batch of actions
   */
  ipcMain.handle('agent:logActionBatch', async (_event, actions: Array<{
    emailId: string;
    actionType: UserActionType;
    threadId?: string;
    actionValue?: string;
    source?: ActionSource;
    senderAddress?: string;
  }>) => {
    try {
      const agentRepo = getAgentRepo();
      const logs = actions.map(a => ({
        id: generateId('act'),
        emailId: a.emailId,
        threadId: a.threadId || null,
        actionType: a.actionType,
        actionValue: a.actionValue || null,
        source: (a.source || 'user') as ActionSource,
        senderAddress: a.senderAddress?.toLowerCase() || null,
        timestamp: Math.floor(Date.now() / 1000),
        createdAt: Math.floor(Date.now() / 1000),
      }));
      await agentRepo.logActionBatch(logs);
      return { success: true, count: logs.length };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Action Queries ==========

  ipcMain.handle('agent:getRecentActions', async (_event, limit?: number, since?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const actions = await agentRepo.getRecentActions(limit, since);
      return { success: true, data: actions };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getActionsByEmail', async (_event, emailId: string) => {
    try {
      const agentRepo = getAgentRepo();
      const actions = await agentRepo.getActionsByEmail(emailId);
      return { success: true, data: actions };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getActionStats', async (_event, since?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const stats = await agentRepo.getActionStats(since);
      return { success: true, data: stats };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Agent Decisions ==========

  ipcMain.handle('agent:getPendingDecisions', async () => {
    try {
      const agentRepo = getAgentRepo();
      const decisions = await agentRepo.getPendingDecisions();
      return { success: true, data: decisions };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:resolveDecision', async (_event, decisionId: string, status: string, actualAction?: string, feedback?: string) => {
    try {
      const agentRepo = getAgentRepo();
      await agentRepo.updateDecisionStatus(decisionId, status as any, actualAction as any, feedback);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getDecisionHistory', async (_event, limit?: number, offset?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const decisions = await agentRepo.getDecisionHistory(limit, offset);
      return { success: true, data: decisions };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getDecisionAccuracy', async (_event, since?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const accuracy = await agentRepo.getDecisionAccuracy(since);
      return { success: true, data: accuracy };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Behavior Analysis ==========

  ipcMain.handle('agent:getSenderPattern', async (_event, senderEmail: string) => {
    try {
      const agentRepo = getAgentRepo();
      const pattern = agentRepo.getSenderResponsePattern(senderEmail);
      return { success: true, data: pattern };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getSenderTiers', async () => {
    try {
      const agentRepo = getAgentRepo();
      const tiers = agentRepo.getSenderTiers();
      return { success: true, data: tiers };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getPeakHours', async () => {
    try {
      const agentRepo = getAgentRepo();
      const hours = agentRepo.getPeakActivityHours();
      return { success: true, data: hours };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:predictAction', async (_event, senderAddress: string) => {
    try {
      const agentRepo = getAgentRepo();
      const prediction = agentRepo.predictAction(senderAddress);
      return { success: true, data: prediction };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Sender Metrics ==========

  ipcMain.handle('agent:getSenderMetrics', async (_event, senderEmail: string, days?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const metrics = await agentRepo.getSenderMetrics(senderEmail, days);
      return { success: true, data: metrics };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getTopSenders', async (_event, actionType: UserActionType, limit?: number, since?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const senders = await agentRepo.getTopSendersByAction(actionType, limit, since);
      return { success: true, data: senders };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Pipeline Events ==========

  ipcMain.handle('agent:getPipelineEvents', async (_event, eventType?: string, limit?: number, since?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const events = await agentRepo.getPipelineEvents(eventType, limit, since);
      return { success: true, data: events };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Agent Service (moved from deleted email-agent-service.ts) ==========

  ipcMain.handle('agent:getConfig', async () => {
    try {
      const p = getUnifiedPipeline();
      return { success: true, data: p?.getConfig() || {} };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:setConfig', async (_event, config: any) => {
    try {
      const p = getUnifiedPipeline();
      if (p) p.updateConfig(config);
      // Mirror to disk so the settings (esp. the `enabled` master switch)
      // survive a restart instead of resetting to OFF each launch.
      if (config && typeof config === 'object') saveAgentConfig(config);

      // Backfill existing Inbox mail into the pipeline (per account, once each).
      if (config?.enabled === true) runBackfillForNewAccounts(500);

      // Profile fields (pushed from Settings → Profile Information). These
      // don't belong in UnifiedPipelineConfig — they're only used by the
      // reply drafter to personalise the LLM prompt and to stamp auto-drafts
      // with a valid From header.
      if (config && (
        'userName' in config ||
        'profileTitle' in config ||
        'profileCompany' in config ||
        'userEmail' in config
      )) {
        setPipelineUserProfile({
          userName: config.userName,
          profileTitle: config.profileTitle,
          profileCompany: config.profileCompany,
          userEmail: config.userEmail,
        });
      }

      // If userEmail arrives, (re)build the agent's history/contacts/sender
      // memory. This is a set of heavy SYNCHRONOUS better-sqlite3 passes, so it is
      // DEFERRED + DEBOUNCED off this handler (see scheduleAgentLearning) — running
      // it inline froze the main event loop for seconds at startup, stalling the
      // connect/account IPC behind it (the renderer then flashed "No account
      // connected"), and the renderer pushes setConfig repeatedly so it ran N times.
      if (config.userEmail) scheduleAgentLearning(config.userEmail);
      return { success: true };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:setEnabled', async (_event, enabled: boolean) => {
    try {
      const p = getUnifiedPipeline();
      if (p) p.updateConfig({ enabled });
      // Persist the master switch so it holds across restarts.
      saveAgentConfig({ enabled });
      // Same per-account backfill as setConfig.
      if (enabled) runBackfillForNewAccounts(500);
      return { success: true };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:isReady', async () => {
    // "Ready" now means "at least one category has enough signal to
    // auto-act" — the old totalActions >= 50 gate was a coarse global
    // heuristic that ignored per-category sample quality. Auto-actions
    // have always been gated per-category (see getCategoryReadiness);
    // this handler now reports the same fact the Dashboard renders.
    try {
      const agentRepo = getAgentRepo();
      const readiness = agentRepo.getCategoryReadiness();
      const anyReady = readiness.some((r: { ready: boolean }) => r.ready);
      return { success: true, data: anyReady };
    } catch { return { success: true, data: false }; }
  });

  ipcMain.handle('agent:getProposals', async () => {
    try {
      const agentRepo = getAgentRepo();
      const storage = requireStorage();
      const decisions = await agentRepo.getPendingDecisions();

      // Enrich with email subject + sender info. Fetch every referenced email
      // in ONE batched query and index by id — avoids an N+1 sequential
      // getEmail per pending decision.
      const emailIds = [...new Set(decisions.map((d: any) => d.emailId).filter(Boolean))];
      const emails = await storage.getEmailsByIds(emailIds as string[]);
      const emailById = new Map(emails.map((e) => [e.id, e]));

      const enriched = decisions.map((d: any) => {
        const email = emailById.get(d.emailId);
        return {
          ...d,
          subject: email?.subject || '',
          fromName: email?.fromName || '',
          fromAddress: email?.fromAddress || d.senderAddress || '',
        };
      });
      return { success: true, data: enriched };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:resolveProposal', async (_event, proposalId: string, approved: boolean, actualAction?: string, feedback?: string) => {
    try {
      const agentRepo = getAgentRepo();
      await agentRepo.updateDecisionStatus(proposalId, approved ? 'approved' : 'rejected', actualAction as any, feedback);
      return { success: true };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:getAccuracyMetrics', async (_event, days?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const since = days ? Math.floor(Date.now() / 1000) - (days * 86400) : undefined;
      const accuracy = await agentRepo.getDecisionAccuracy(since);
      return { success: true, data: accuracy };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:getBehaviorProfile', async () => {
    try {
      // Return learning summary as profile
      const agentRepo = getAgentRepo();
      const summary = agentRepo.getLearningSummary();
      const tiers = agentRepo.getSenderTiers();
      return { success: true, data: { ...summary, ...tiers } };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:getReplyStyleProfile', async () => {
    return { success: true, data: null }; // TODO: implement when reply generation is active
  });

  ipcMain.handle('agent:generateReply', async () => {
    return { success: false, error: 'Reply generation not yet connected' };
  });

  // ========== Agent Activity Log + Undo ==========

  ipcMain.handle('agent:getAgentActions', async (_event, limit?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const storage = requireStorage();
      const actions = await agentRepo.getRecentActions(limit || 100);

      // Enrich with email subject + fromName. One batched lookup indexed by id
      // instead of up to `limit` sequential getEmail calls (N+1).
      const emailIds = [...new Set(actions.map((a: any) => a.emailId).filter(Boolean))];
      const emails = await storage.getEmailsByIds(emailIds as string[]);
      const emailById = new Map(emails.map((e) => [e.id, e]));

      const enriched = actions.map((action: any) => {
        const email = emailById.get(action.emailId);
        return {
          ...action,
          subject: email?.subject || '',
          fromName: email?.fromName || '',
        };
      });

      return { success: true, data: enriched };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:undoAction', async (_event, actionId: string) => {
    try {
      const agentRepo = getAgentRepo();
      const storage = requireStorage();

      // Find the action
      const allActions = await agentRepo.getRecentActions(500);
      const action = allActions.find((a: any) => a.id === actionId);
      if (!action) return { success: false, error: 'Action not found' };

      const email = await storage.getEmail(action.emailId);
      if (!email) return { success: false, error: 'Email not found' };

      const tags = email.tags || '||';

      // Reverse the action
      switch (action.actionType) {
        case 'read': {
          // Undo read → mark unread
          const tagList = tags.split('|').filter((t: string) => t.length > 0 && t !== 'read');
          await storage.updateEmail(action.emailId, { tags: tagList.length > 0 ? '|' + tagList.join('|') + '|' : '||' });
          break;
        }
        case 'star': {
          // Undo star → remove star
          const tagList = tags.split('|').filter((t: string) => t.length > 0 && t !== 'starred');
          await storage.updateEmail(action.emailId, { tags: tagList.length > 0 ? '|' + tagList.join('|') + '|' : '||' });
          break;
        }
        case 'archive': {
          // Undo archive → move back to inbox
          const folders = await storage.getFolders();
          const inbox = folders.find((f: any) => f.path === 'INBOX');
          if (inbox) {
            let newTags = tags;
            if (!newTags.includes('|INBOX|')) {
              const tl = newTags.split('|').filter((t: string) => t.length > 0);
              tl.push('INBOX');
              newTags = '|' + tl.join('|') + '|';
            }
            await storage.updateEmail(action.emailId, { folderId: inbox.id, tags: newTags });
          }
          break;
        }
        case 'important': {
          const tagList = tags.split('|').filter((t: string) => t.length > 0 && t !== 'important');
          await storage.updateEmail(action.emailId, { tags: tagList.length > 0 ? '|' + tagList.join('|') + '|' : '||' });
          break;
        }
        default:
          return { success: false, error: `Cannot undo action type: ${action.actionType}` };
      }

      // Log the undo as the INVERSE action — re-logging the same type with
      // source 'user' would teach the agent the opposite of what happened
      // (e.g. that the user archives this sender right after un-archiving).
      // UserActionType has no 'unarchive', so archive undos are not logged.
      const inverseAction: Partial<Record<string, UserActionType>> = {
        read: 'unread',
        star: 'unstar',
        important: 'unimportant',
      };
      const undoType = inverseAction[action.actionType];
      if (undoType) {
        logUserAction(action.emailId, undoType, {
          threadId: action.threadId,
          senderAddress: action.senderAddress,
          source: 'user',
          actionValue: JSON.stringify({ undoOf: actionId }),
        });
      }

      logger.info(`[Agent] Undo: reversed ${action.actionType} on ${action.emailId}`);
      return { success: true, data: { undone: action.actionType, emailId: action.emailId } };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  // ========== Contact Notes ==========

  ipcMain.handle('agent:getNotes', async (_event, email: string, limit?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const notes = agentRepo.getNotes(email, limit);
      return { success: true, data: notes };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:addNote', async (_event, email: string, note: string, category: string) => {
    try {
      const agentRepo = getAgentRepo();
      const id = agentRepo.addNote(email, note, category);
      return { success: true, data: { id } };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:editNote', async (_event, id: number, note: string) => {
    try {
      const agentRepo = getAgentRepo();
      agentRepo.updateNote(id, note);
      return { success: true };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:deleteNote', async (_event, id: number) => {
    try {
      const agentRepo = getAgentRepo();
      agentRepo.deactivateNote(id);
      return { success: true };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  ipcMain.handle('agent:getNotesCount', async (_event, email: string) => {
    try {
      const agentRepo = getAgentRepo();
      return { success: true, data: agentRepo.getNotesCount(email) };
    } catch (error) { return { success: false, error: (error as Error).message }; }
  });

  // ========== Agentic Reply Drafting ==========

  ipcMain.handle('agent:draftReply', async (_event, emailId: string) => {
    try {
      const storage = requireStorage();
      const email = await storage.getEmail(emailId);
      if (!email) return { success: false, error: 'Email not found' };

      const agentRepo = getAgentRepo();

      // Build drafter deps
      const { AgentReplyDrafter } = require('@sarvinbox/core');
      const { callAIWithRetry } = require('@sarvinbox/core');

      // Shared identity resolver (registry-first) — same source as the pipeline.
      const userEmail = resolveAccountEmail(storage);

      const drafter = new AgentReplyDrafter({
        userEmail,
        userName: userEmail.split('@')[0] || '',
        callAI: async (sys: string, msg: string) => {
          // aiConfig is module-local in the pipeline service — reach it via
          // the exported getter (svc.aiConfig was always undefined).
          const cfg = getPipelineAIConfig();
          if (!cfg) throw new Error('No AI provider configured');
          return callAIWithRetry(cfg, sys, msg);
        },
        getNotes: (e: string) => agentRepo.getNotesForPrompt(e),
        getThreadMessages: (threadId: string) => {
          try {
            // storage.getEmailsByThread is async but this drafter dep is
            // synchronous — query via better-sqlite3 directly.
            // Body read through email_bodies (migration 73 empties the inline
            // column) — otherwise the reply drafter sees an empty thread and
            // writes a reply with no context, which reads as the model being bad
            // rather than as a storage bug.
            const emails = ((storage as any).db?.prepare?.(
              `SELECT from_address AS fromAddress, date, ${cleanBodyExpression()} AS cleanBody ` +
                'FROM emails WHERE thread_id = ? ORDER BY date ASC'
            )?.all(threadId) || []) as any[];
            return emails.slice(-10).map((e: any) => ({
              from: e.fromAddress || '',
              date: e.date,
              body: (e.cleanBody || '').substring(0, 300),
            }));
          } catch { return []; }
        },
        getSenderMemory: (e: string) => {
          try {
            const row = (storage as any).db?.prepare?.(
              'SELECT greeting, closing, tone FROM sender_stats WHERE email = ?'
            )?.get(e.toLowerCase()) as any;
            return { greeting: row?.greeting || null, closing: row?.closing || null, tone: row?.tone || null };
          } catch { return { greeting: null, closing: null, tone: null }; }
        },
        searchEmails: (query: string, options?: { from?: string; limit?: number }) => {
          try {
            const results = (storage as any).fullTextSearch?.(query, {
              from: options?.from,
              limit: options?.limit || 5,
            }) || [];
            return results.map((r: any) => ({
              id: r.id,
              subject: r.subject || '',
              from: r.fromAddress || '',
              date: r.date,
              snippet: (r.cleanBody || '').substring(0, 200),
            }));
          } catch { return []; }
        },
      });

      const result = await drafter.draftReply(email);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Pipeline Stats ==========

  ipcMain.handle('agent:getPipelineStats', async () => {
    try {
      const agentRepo = getAgentRepo();
      const stats = agentRepo.getPipelineStats();
      return { success: true, data: stats };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getCategoryReadiness', async () => {
    try {
      const agentRepo = getAgentRepo();
      const data = agentRepo.getCategoryReadiness();
      return { success: true, data };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getEmailsByPriority', async (_event, limit?: number, minScore?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const emails = agentRepo.getEmailsByPriority(limit, minScore);
      return { success: true, data: emails };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Priority Scoring ==========

  ipcMain.handle('agent:scoreEmail', async (_event, emailId: string) => {
    try {
      const intel = getIntelligence();
      if (!intel) return { success: false, error: 'Intelligence not initialized' };

      const storage = requireStorage();
      const email = await storage.getEmail(emailId);
      if (!email) return { success: false, error: 'Email not found' };

      const score = intel.scoreEmail(email);
      return { success: true, data: score };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:scoreWaitingEmails', async (_event, limit?: number) => {
    try {
      const intel = getIntelligence();
      if (!intel) return { success: false, error: 'Intelligence not initialized' };

      const storage = requireStorage();
      // Get unread emails from last 7 days, excluding noise folders
      const agentRepo = getAgentRepo();
      const waiting = agentRepo.getWaitingUserActions(limit || 50);

      // Batch-load every waiting email in one query, indexed by id — replaces
      // up to `limit` sequential getEmail calls (N+1).
      const emailIds = [...new Set(waiting.map((item: any) => item.emailId).filter(Boolean))];
      const emails = await storage.getEmailsByIds(emailIds as string[]);
      const emailById = new Map(emails.map((e) => [e.id, e]));

      const scored: any[] = [];
      for (const item of waiting) {
        const email = emailById.get(item.emailId);
        if (!email) continue;

        try {
          const score = intel.scoreEmail(email);
          scored.push({
            emailId: item.emailId,
            subject: item.subject,
            fromAddress: item.fromAddress,
            fromName: item.fromName,
            ...score,
          });
        } catch {
          // Skip emails that fail scoring
        }
      }

      // Sort by priority score descending
      scored.sort((a: any, b: any) => b.score - a.score);
      return { success: true, data: scored };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Historical Learning ==========

  ipcMain.handle('agent:backfillHistory', async (_event, force?: boolean) => {
    try {
      const agentRepo = getAgentRepo();
      if (force) {
        // Clear old backfill data to re-learn
        (agentRepo as any).db?.prepare?.("DELETE FROM user_action_log WHERE source = 'history'")?.run();
      }
      const result = agentRepo.backfillFromHistory();
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:isBackfilled', async () => {
    try {
      const agentRepo = getAgentRepo();
      return { success: true, data: agentRepo.isBackfilled() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getLearningSummary', async () => {
    try {
      const agentRepo = getAgentRepo();
      const summary = agentRepo.getLearningSummary();
      return { success: true, data: summary };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Contact Classification ==========

  ipcMain.handle('agent:setContactType', async (_event, email: string, contactType: string, source?: string) => {
    try {
      const agentRepo = getAgentRepo();
      agentRepo.setContactType(email, contactType as any, 1.0, (source || 'user') as any);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:autoClassifyContacts', async (_event, userEmail: string) => {
    try {
      const agentRepo = getAgentRepo();
      const count = agentRepo.autoClassifyContacts(userEmail);
      return { success: true, data: { classified: count } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getContactsByType', async (_event, contactType: string, options?: { limit?: number; offset?: number; search?: string }) => {
    try {
      const agentRepo = getAgentRepo();
      const contacts = agentRepo.getContactsByType(contactType as any, options);
      return { success: true, data: contacts };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getContactTypeCounts', async () => {
    try {
      const agentRepo = getAgentRepo();
      const counts = agentRepo.getContactTypeCounts();
      return { success: true, data: counts };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:getContactsNeedingResponse', async (_event, limit?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const contacts = agentRepo.getContactsNeedingResponse(limit);
      return { success: true, data: contacts };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('agent:refreshNeedsResponse', async () => {
    try {
      const agentRepo = getAgentRepo();
      const count = agentRepo.refreshNeedsResponse();
      return { success: true, data: { updated: count } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Waiting Actions & Activity ==========

  ipcMain.handle('agent:getWaitingActions', async (_event, limit?: number) => {
    try {
      const agentRepo = getAgentRepo();
      const actions = agentRepo.getWaitingUserActions(limit);
      return { success: true, data: actions };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Agent Action Execution (with testMode support) ==========

  /**
   * Execute an agent action on an email
   * In testMode: updates local DB only, skips IMAP sync
   * This allows re-testing the agent without permanently changing email state
   */
  ipcMain.handle('agent:executeAction', async (_event, emailId: string, action: string, options?: { testMode?: boolean; value?: string }) => {
    try {
      const storage = requireStorage();
      const email = await storage.getEmail(emailId);
      if (!email) return { success: false, error: 'Email not found' };

      const testMode = options?.testMode || false;
      const syncEngine = testMode ? null : getSyncEngine();

      switch (action) {
        case 'read': {
          const tags = email.tags || '||';
          if (!tags.includes('|read|')) {
            const tagList = tags.split('|').filter((t: string) => t.length > 0);
            tagList.push('read');
            await storage.updateEmail(emailId, { tags: '|' + tagList.join('|') + '|' });
          }
          if (syncEngine?.isConnected() && email.uid) {
            const folder = await storage.getFolder(email.folderId);
            if (folder) syncEngine.markAsRead(folder.path, email.uid).catch(console.error);
          }
          break;
        }
        case 'star': {
          const tags = email.tags || '||';
          if (!tags.includes('|starred|')) {
            const tagList = tags.split('|').filter((t: string) => t.length > 0);
            tagList.push('starred');
            await storage.updateEmail(emailId, { tags: '|' + tagList.join('|') + '|' });
          }
          if (syncEngine?.isConnected() && email.uid) {
            const folder = await storage.getFolder(email.folderId);
            if (folder) syncEngine.markAsStarred(folder.path, email.uid, true).catch(console.error);
          }
          break;
        }
        case 'archive': {
          const folders = await storage.getFolders();
          const archiveFolder = folders.find((f: any) =>
            f.path === '[Gmail]/All Mail' || f.path.toLowerCase().includes('archive')
          );
          if (archiveFolder) {
            await storage.updateEmail(emailId, { folderId: archiveFolder.id });
          }
          if (syncEngine?.isConnected() && email.uid) {
            const folder = await storage.getFolder(email.folderId);
            if (folder) {
              const opQueue = (syncEngine as any).operationQueue;
              opQueue?.archive(folder.path, email.uid).catch(console.error);
            }
          }
          break;
        }
        case 'important': {
          const tags = email.tags || '||';
          if (!tags.includes('|important|')) {
            const tagList = tags.split('|').filter((t: string) => t.length > 0);
            tagList.push('important');
            await storage.updateEmail(emailId, { tags: '|' + tagList.join('|') + '|' });
          }
          break;
        }
        default:
          return { success: false, error: `Unknown action: ${action}` };
      }

      // Log the agent action
      logUserAction(emailId, action as any, {
        threadId: email.threadId,
        senderAddress: email.fromAddress,
        source: 'agent_auto',
      });

      if (testMode) {
        logger.info(`[Agent] TestMode: ${action} on ${emailId} (local only, no IMAP sync)`);
      }

      return { success: true, testMode };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  logger.info('[IPC] Agent handlers registered');
}
