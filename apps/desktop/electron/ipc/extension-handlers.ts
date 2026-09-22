/**
 * Extension IPC Handlers
 *
 * Handles extension management and extension function calls.
 */

import type { ExtensionUIAction, PanelRequest, PanelResponse } from '@sarvinbox/core';
import { createLogger, parsePanelRequest, toPanelMessage } from '@sarvinbox/core';
import { ipcMain, dialog } from 'electron';

import {
  fetchCatalog,
  getExtensionsConfig,
  getRegistryEntry,
  installFromRegistry,
} from '../services/extension-marketplace';
import { getExtensionManager, getMainWindow, getStorage } from '../shared';

const logger = createLogger('extension-handlers');

export function registerExtensionHandlers(): void {
  // ========== Capabilities ==========

  /**
   * Call whichever extension serves a capability.
   *
   * The app names the JOB ('thread.summarize'), never an extension. Which
   * extension answers is decided by the manifests currently installed, so
   * shipping a different summarizer, or none at all, needs no change here.
   *
   * `served: false` is the ordinary state of a fresh install, not an error —
   * the caller falls back to whatever it would have done without extensions.
   * A provider that exists and then FAILS does surface as an error, because
   * that one is a bug worth seeing.
   */
  ipcMain.handle('extensions:invoke', async (_event, capability: string, args?: unknown[]) => {
    try {
      if (typeof capability !== 'string' || !capability) {
        return { success: false, error: 'A capability id is required' };
      }
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: true, data: { served: false } };
      }
      const result = await extensionManager.invokeCapability(
        capability,
        Array.isArray(args) ? args : []
      );
      return { success: true, data: result };
    } catch (error) {
      logger.error(`[Extensions] Capability '${capability}' failed:`, error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Every capability an active extension currently serves, so a surface can
   * decide whether to offer a feature at all before invoking it.
   */
  ipcMain.handle('extensions:capabilities', async () => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: true, data: [] };
      }
      return { success: true, data: extensionManager.listCapabilities() };
    } catch (error) {
      logger.error('[Extensions] List capabilities error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * A reader acted on an extension's notification card (copied a field,
   * dismissed it, opened the message, or the countdown ran out).
   *
   * The renderer reports WHAT happened and never decides what it means: the
   * extension that raised the card is recovered from the namespaced id in the
   * main process, and the extension's own handler runs in its sandbox. A card
   * whose extension has since been disabled resolves to `false` rather than
   * failing, so a stale card in the window cannot produce an error dialog.
   */
  ipcMain.handle(
    'extensions:cardAction',
    async (_event, notificationId: string, action: Omit<ExtensionUIAction, 'notificationId'>) => {
      try {
        if (typeof notificationId !== 'string' || !notificationId || !action?.action) {
          return { success: false, error: 'A notification id and an action are required' };
        }
        const extensionManager = getExtensionManager();
        if (!extensionManager) {
          return { success: true, data: false };
        }
        const delivered = await extensionManager.dispatchNotificationAction(notificationId, action);
        return { success: true, data: delivered };
      } catch (error) {
        logger.error('[Extensions] Card action error:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  /**
   * Check if an extension is available and active
   */
  ipcMain.handle('extension:isAvailable', async (_event, extensionId: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: true, data: false };
      }
      const host = extensionManager.getHost();
      return { success: true, data: host.isActive(extensionId) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Extension Management Handlers ==========

  /**
   * List all installed extensions
   */
  ipcMain.handle('extensions:list', async () => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: true, data: [] };
      }
      const extensions = extensionManager.getInstalledExtensions();
      return { success: true, data: extensions };
    } catch (error) {
      logger.error('[Extensions] List error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Get extension info by ID
   */
  ipcMain.handle('extensions:getInfo', async (_event, extensionId: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: false, error: 'Extension manager not initialized' };
      }

      const info = extensionManager.getExtensionInfo(extensionId);
      const registry = extensionManager.getRegistry();
      const loaded = registry.getLoaded(extensionId);

      if (!info && !loaded) {
        return { success: false, error: `Extension '${extensionId}' not found` };
      }

      const result = {
        manifest: loaded?.manifest || null,
        state: info?.state || 'unloaded',
        enabled: info?.enabled ?? false,
        path: loaded?.path || info?.path || '',
        error: info?.error,
        activatedAt: info?.activatedAt,
        workflowIds: info?.workflowIds || [],
      };

      return { success: true, data: result };
    } catch (error) {
      logger.error('[Extensions] Get info error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Enable an extension
   */
  ipcMain.handle('extensions:enable', async (_event, extensionId: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: false, error: 'Extension manager not initialized' };
      }
      await extensionManager.enableExtension(extensionId);
      return { success: true };
    } catch (error) {
      logger.error('[Extensions] Enable error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Disable an extension
   */
  ipcMain.handle('extensions:disable', async (_event, extensionId: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: false, error: 'Extension manager not initialized' };
      }
      await extensionManager.disableExtension(extensionId);
      return { success: true };
    } catch (error) {
      logger.error('[Extensions] Disable error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Uninstall an extension
   */
  ipcMain.handle('extensions:uninstall', async (_event, extensionId: string) => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: false, error: 'Extension manager not initialized' };
      }
      await extensionManager.uninstallExtension(extensionId);
      return { success: true };
    } catch (error) {
      logger.error('[Extensions] Uninstall error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Open dialog to select and install an extension
   */
  ipcMain.handle('extensions:selectAndInstall', async () => {
    try {
      const extensionManager = getExtensionManager();
      const mainWindow = getMainWindow();

      if (!extensionManager) {
        return { success: false, error: 'Extension manager not initialized' };
      }

      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ['openDirectory'],
        title: 'Select Extension Folder',
        message: 'Select a folder containing a Sarv Inbox extension',
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'No folder selected' };
      }

      const extensionPath = result.filePaths[0];
      const installed = await extensionManager.installExtension(extensionPath);

      return { success: true, data: installed };
    } catch (error) {
      logger.error('[Extensions] Install error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Marketplace ==========

  /**
   * The Browse tab: everything the configured registries offer, merged with
   * what is installed and checked against this app version.
   */
  ipcMain.handle('extensions:browse', async (_event, options?: { force?: boolean }) => {
    try {
      const catalog = await fetchCatalog({ force: options?.force === true });
      return { success: true, data: catalog };
    } catch (error) {
      logger.error('[Extensions] Browse error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * One extension's full record, for the permission prompt.
   *
   * The Browse list is drawn from a thin index that carries no download URL and
   * no digest; the prompt shows the digest, so it asks for the rest of the
   * record here, for the one extension the user clicked.
   */
  ipcMain.handle('extensions:registryDetail', async (_event, extensionId: string) => {
    try {
      if (typeof extensionId !== 'string') {
        return { success: false, error: 'An extension id is required' };
      }
      const entry = await getRegistryEntry(extensionId);
      return { success: true, data: entry };
    } catch (error) {
      logger.error('[Extensions] Registry detail error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Install an extension the user has just approved in the permission prompt.
   *
   * `permissions` is the list the renderer actually showed them. The main
   * process re-checks it against the registry, so an extension whose
   * permissions changed between the prompt being drawn and Install being
   * clicked is refused rather than silently granted the new set.
   */
  ipcMain.handle(
    'extensions:installFromRegistry',
    async (_event, extensionId: string, permissions: string[]) => {
      try {
        if (typeof extensionId !== 'string' || !Array.isArray(permissions)) {
          return { success: false, error: 'An extension id and the approved permissions are required' };
        }
        const installed = await installFromRegistry(extensionId, permissions);
        return { success: true, data: installed };
      } catch (error) {
        logger.error('[Extensions] Registry install error:', error);
        return { success: false, error: (error as Error).message };
      }
    }
  );

  /**
   * Which registries this build reads, so the panel can name its sources.
   */
  ipcMain.handle('extensions:getRegistries', async () => {
    try {
      const { registries, systemExtensions } = getExtensionsConfig();
      return { success: true, data: { registries, systemExtensions } };
    } catch (error) {
      logger.error('[Extensions] Get registries error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // ========== Panels ==========

  /**
   * Every panel the app should offer right now.
   */
  ipcMain.handle('extensions:listPanels', async () => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: true, data: [] };
      }
      return { success: true, data: extensionManager.listPanels() };
    } catch (error) {
      logger.error('[Extensions] List panels error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * One request from a panel iframe.
   *
   * The renderer relays; it decides nothing. The payload is re-validated here
   * rather than trusted, because it originated in extension-authored code that
   * runs in the reader's window — `parsePanelRequest` is what stops a malformed
   * or invented request reaching the host at all.
   *
   * `currentMessageId` is the renderer saying WHICH message is open, never what
   * it contains: the row is read from storage here and reduced to the subset a
   * panel may see.
   */
  ipcMain.handle(
    'extensions:panelRequest',
    async (
      _event,
      extensionId: string,
      payload: unknown,
      context?: { currentMessageId?: string }
    ): Promise<PanelResponse> => {
      const request: PanelRequest | undefined = parsePanelRequest(payload);
      if (!request) {
        // No requestId to answer with — the payload was not a request at all.
        return { requestId: '', ok: false, error: 'Malformed panel request' };
      }

      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { requestId: request.requestId, ok: false, error: 'Extensions are not running' };
      }

      return extensionManager.servePanelRequest(extensionId, request, {
        getCurrentMessage: async () => {
          const messageId = context?.currentMessageId;
          if (!messageId) return null;
          const storage = getStorage();
          if (!storage) return null;
          const email = await storage.getEmail(messageId);
          return email ? toPanelMessage(email) : null;
        },
      });
    }
  );

  /**
   * Get active workflow IDs
   */
  ipcMain.handle('extensions:getWorkflows', async () => {
    try {
      const extensionManager = getExtensionManager();
      if (!extensionManager) {
        return { success: true, data: [] };
      }
      const workflowIds = extensionManager.getActiveWorkflowIds();
      return { success: true, data: workflowIds };
    } catch (error) {
      logger.error('[Extensions] Get workflows error:', error);
      return { success: false, error: (error as Error).message };
    }
  });
}
