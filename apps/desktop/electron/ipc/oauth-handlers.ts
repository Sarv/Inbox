/**
 * OAuth IPC Handlers
 *
 * Thin bridge from renderer to the main-process OAuth service.
 */

import { ipcMain } from 'electron';
import {
  getOAuthProvider,
  isOAuthProviderConfigured,
  listOAuthProviders,
  type OAuthProviderId,
} from '@sarvinbox/core';
import {
  cancelOAuthFlow,
  getValidAccessToken,
  listSignedInAccounts,
  signOut,
  startOAuthFlow,
} from '../services/oauth-service';
import { rescheduleOAuthAccount, unscheduleOAuthAccount } from '../services/oauth-refresh-scheduler';

export function registerOAuthHandlers(): void {
  ipcMain.handle('oauth:listProviders', async () => {
    try {
      const providers = listOAuthProviders().map((p) => ({
        id: p.id,
        label: p.label,
        purpose: p.purpose,
        configured: Boolean(p.clientId),
        imapHost: p.imap?.host ?? null,
        smtpHost: p.smtp?.host ?? null,
        llmBaseUrl: p.llmBaseUrl ?? null,
        apiBaseUrl: p.apiBaseUrl ?? null,
        edgeBaseUrl: p.edgeBaseUrl ?? null,
      }));
      return { success: true, data: providers };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('oauth:startFlow', async (_event, providerId: OAuthProviderId) => {
    try {
      if (!isOAuthProviderConfigured(providerId)) {
        return {
          success: false,
          error: `${providerId} OAuth not configured. See OAUTH_SETUP.md.`,
        };
      }
      const account = await startOAuthFlow(providerId);
      // Newly signed-in / re-authed account: arm its proactive refresh.
      rescheduleOAuthAccount(account.provider, account.email);
      const provider = getOAuthProvider(providerId);
      return {
        success: true,
        data: {
          provider: account.provider,
          purpose: provider.purpose,
          email: account.email,
          displayName: account.displayName,
          imap: provider.imap ?? null,
          smtp: provider.smtp ?? null,
          llmBaseUrl: provider.llmBaseUrl ?? null,
          apiBaseUrl: provider.apiBaseUrl ?? null,
          edgeBaseUrl: provider.edgeBaseUrl ?? null,
          scopes: account.scopes,
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Abort an in-flight interactive sign-in (user hit Back / closed the modal).
  // Frees the loopback port and rejects the pending startFlow with FLOW_CANCELLED
  // so the button becomes clickable again.
  ipcMain.handle('oauth:cancel', async () => {
    try {
      cancelOAuthFlow();
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('oauth:listAccounts', async () => {
    try {
      const accounts = await listSignedInAccounts();
      // Never expose tokens to the renderer.
      const safe = accounts.map((a) => ({
        provider: a.provider,
        email: a.email,
        displayName: a.displayName,
        scopes: a.scopes,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
      }));
      return { success: true, data: safe };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(
    'oauth:signOut',
    async (_event, providerId: OAuthProviderId, email: string) => {
      try {
        await signOut(providerId, email);
        unscheduleOAuthAccount(providerId, email);
        return { success: true };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  );

  /**
   * Return a currently-valid access token for the given OAuth account,
   * refreshing if it's near expiry. The renderer calls this right before
   * hitting Sarv APIs / the edge LLM gateway so it doesn't have to manage
   * refresh lifecycle.
   */
  ipcMain.handle(
    'oauth:getAccessToken',
    async (_event, providerId: OAuthProviderId, email: string) => {
      try {
        const accessToken = await getValidAccessToken(providerId, email);
        return { success: true, data: { accessToken } };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  );
}
