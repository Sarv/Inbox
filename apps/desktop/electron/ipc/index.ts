/**
 * IPC Handlers Index
 *
 * Registers all IPC handlers for the Electron main process.
 */

import { installNodeSignatureSplitter, createLogger } from '@sarvinbox/core';

import { registerAccountsHandlers } from './accounts-handlers';
import { registerAgentHandlers } from './agent-handlers';
import { registerAICategorizationHandlers } from './ai-categorization-handlers';
import { registerAIHandlers } from './ai-handlers';
import { registerAppHandlers } from './app-handlers';
import { registerContactEnrichmentHandlers } from './contact-enrichment-handlers';
import { registerContactsHandlers } from './contacts-handlers';
import { registerDraftHandlers } from './draft-handlers';
import { registerEmailHandlers } from './email-handlers';
import { registerExtensionHandlers } from './extension-handlers';
import { registerFilterHandlers } from './filter-handlers';
import { registerFolderHandlers } from './folder-handlers';
import { registerLabelHandlers } from './label-handlers';
import { registerMiscHandlers } from './misc-handlers';
import { registerNotificationHandlers } from './notification-handlers';
import { registerOAuthHandlers } from './oauth-handlers';
import { registerQueueHandlers } from './queue-handlers';
import { registerSecureCredentialsHandlers } from './secure-credentials-handlers';
import { registerSmtpHandlers } from './smtp-handlers';
import { registerStorageHandlers } from './storage-handlers';
import { registerSyncHandlers } from './sync-handlers';

/**
 * Register all IPC handlers
 * Call this once during app initialization
 */
export function registerAllHandlers(): void {
  registerAppHandlers();
  // Give the shared enrichment code the better (Node-only) signature parser.
  // core stays browser-safe by default; the renderer never installs one and
  // falls back to the local delimiter heuristics.
  installNodeSignatureSplitter();

  registerSyncHandlers();
  registerFolderHandlers();
  registerEmailHandlers();
  registerSmtpHandlers();
  registerContactsHandlers();
  registerAIHandlers();
  registerExtensionHandlers();
  registerMiscHandlers();
  registerAICategorizationHandlers();
  registerDraftHandlers();
  registerAgentHandlers();
  registerOAuthHandlers();
  registerContactEnrichmentHandlers();
  registerQueueHandlers();
  registerFilterHandlers();
  registerLabelHandlers();
  registerAccountsHandlers();
  registerSecureCredentialsHandlers();
  registerNotificationHandlers();
  registerStorageHandlers();

  logger.info('[IPC] All handlers registered');
}

// Re-export individual register functions for selective registration
export {
  registerAppHandlers,
  registerSyncHandlers,
  registerFolderHandlers,
  registerEmailHandlers,
  registerSmtpHandlers,
  registerContactsHandlers,
  registerAIHandlers,
  registerExtensionHandlers,
  registerMiscHandlers,
  registerAICategorizationHandlers,
  registerDraftHandlers,
  registerAgentHandlers,
  registerOAuthHandlers,
  registerQueueHandlers,
  registerFilterHandlers,
  registerLabelHandlers,
  registerStorageHandlers,
};

// Re-export app version getter
export { getAppVersion } from './app-handlers';
const logger = createLogger('index');
