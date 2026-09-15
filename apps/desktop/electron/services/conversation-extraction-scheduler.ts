/**
 * Conversation Extraction Scheduler
 *
 * Background scheduler that pre-extracts conversations for multi-email threads
 * so chat view loads instantly without showing "Extracting...".
 *
 * Runs every 45s in the main process, queries threads needing extraction,
 * and sends batch IPC to the renderer for AI processing.
 */

import { createLogger } from '@sarvinbox/core';

import { getStorage, getMainWindow } from '../shared';
const logger = createLogger('conversation-extraction-scheduler');

let schedulerInterval: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;
let aiProviderConfigured = false;

const INTERVAL_MS = 45_000; // 45 seconds
const INITIAL_DELAY_MS = 10_000; // 10 seconds after startup
const BATCH_SIZE = 5;

/**
 * Check for threads needing extraction and send to renderer
 */
async function checkPendingExtractions(): Promise<void> {
  if (!aiProviderConfigured) return;

  const storage = getStorage();
  if (!storage) return;

  const mainWindow = getMainWindow();
  if (!mainWindow) return;

  try {
    const pending = await (storage as any).threadRepo.getPendingExtractionThreads(BATCH_SIZE);
    if (pending.length === 0) return;

    logger.info(`[ConversationScheduler] Found ${pending.length} threads pending extraction`);

    // Send thread IDs to renderer for AI processing
    mainWindow.webContents.send('conversation:extract-batch', {
      threads: pending,
    });
  } catch (error) {
    logger.error('[ConversationScheduler] Error checking pending extractions:', error);
  }
}

/**
 * Start the conversation extraction scheduler
 */
export function startConversationScheduler(): void {
  if (schedulerInterval) return;

  logger.info('[ConversationScheduler] Starting (45s interval)');

  // First tick after initial delay (tracked so stop() can cancel it —
  // otherwise it fires after storage close on a fast quit)
  initialTimer = setTimeout(() => {
    initialTimer = null;
    checkPendingExtractions().catch(() => {});
  }, INITIAL_DELAY_MS);

  // Regular interval
  schedulerInterval = setInterval(() => {
    checkPendingExtractions().catch(() => {});
  }, INTERVAL_MS);
}

/**
 * Stop the conversation extraction scheduler
 */
export function stopConversationScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('[ConversationScheduler] Stopped');
  }
}

/**
 * Set whether an AI provider is configured (called from renderer via IPC)
 */
export function setAIProviderConfigured(configured: boolean): void {
  aiProviderConfigured = configured;
  logger.info(`[ConversationScheduler] AI provider configured: ${configured}`);
}

/**
 * Whether the renderer has reported an AI provider as configured. Other
 * main-process services (e.g. the unified pipeline) use this to skip
 * renderer extraction round-trips that would just stall and time out.
 */
export function isAIProviderConfigured(): boolean {
  return aiProviderConfigured;
}
