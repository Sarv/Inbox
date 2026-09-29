/**
 * OAuth IPC Handlers
 *
 * Thin bridge from renderer to the main-process OAuth service.
 */

import {
  createLogger,
  getOAuthProvider,
  isOAuthProviderConfigured,
  listOAuthProviders,
  type OAuthProviderId,
} from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { rescheduleOAuthAccount, signOutOAuthAccount } from '../services/oauth-refresh-scheduler';
import {
  cancelOAuthFlow,
  getValidAccessToken,
  listSignedInAccounts,
  startOAuthFlow,
} from '../services/oauth-service';
import { listReauthRequired } from '../services/reauth-registry';

const logger = createLogger('oauth-handlers');

/**
 * The only providers whose access token may be handed to the renderer.
 *
 * An allow-list, so a provider added later stays in the main process until
 * someone decides otherwise. Sarv is on it because the renderer calls the Sarv
 * API and the edge LLM gateway itself. The mail providers are not: the renderer
 * also hosts email HTML and extension panels, and nothing there needs a Gmail
 * (https://mail.google.com/) or Microsoft mailbox token. IMAP, SMTP and the
 * Gmail label API all fetch theirs inside main via `getValidAccessToken`.
 */
const RENDERER_TOKEN_PROVIDERS: ReadonlySet<string> = new Set<OAuthProviderId>(['sarv']);

/** Narrows an untrusted IPC argument to a provider the renderer may hold a token for. */
function isRendererTokenProvider(providerId: unknown): providerId is OAuthProviderId {
  return typeof providerId === 'string' && RENDERER_TOKEN_PROVIDERS.has(providerId);
}

/**
 * Name a refused provider for the log and the error, but only a real one. The
 * id comes from the renderer, so anything unrecognised is described rather than
 * echoed: a crafted string must not be able to forge lines in app.log.
 */
function describeRefusedProvider(providerId: unknown): string {
  return listOAuthProviders().some((p) => p.id === providerId)
    ? String(providerId)
    : 'an unrecognised provider';
}

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

  /**
   * Which accounts are waiting for the user to sign in again.
   *
   * PULLED by the renderer on mount, because the push (`oauth:reauth-required`)
   * can be emitted while no window is listening — during startup, after a
   * renderer reload, or while the app sat in the background. Without this the
   * banner would depend on having been present at the exact moment of failure.
   */
  ipcMain.handle('oauth:listReauthRequired', async () => {
    try {
      return { success: true, data: listReauthRequired() };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle(
    'oauth:signOut',
    async (_event, providerId: OAuthProviderId, email: string) => {
      try {
        const { revocation } = await signOutOAuthAccount(providerId, email);
        return { success: true, data: { revocation: await revocation } };
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
   *
   * Only for RENDERER_TOKEN_PROVIDERS. Any other provider is refused before the
   * token store is read, so the answer is the same whether or not such an
   * account exists, and no refresh is ever started on the renderer's behalf.
   */
  ipcMain.handle(
    'oauth:getAccessToken',
    async (_event, providerId: unknown, email: string) => {
      if (!isRendererTokenProvider(providerId)) {
        const which = describeRefusedProvider(providerId);
        logger.warn(
          `[OAuth] refused the renderer an access token for ${which}; only Sarv tokens leave the main process`,
        );
        return { success: false, error: `Access tokens for ${which} are not available to the renderer` };
      }
      try {
        const accessToken = await getValidAccessToken(providerId, email);
        return { success: true, data: { accessToken } };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  );
}
