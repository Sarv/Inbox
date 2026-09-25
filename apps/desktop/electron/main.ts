/**
 * Electron Main Process
 *
 * Entry point for the Sarv Inbox desktop application.
 * Handles app lifecycle, window management, and initialization.
 */


// Every import in this file is evaluated before ANY statement below it —
// that is how ES modules work, regardless of where the import is written. The
// import block used to be split in two around the startup statements, which
// read as if the statements ran between them; they never did. Kept in one
// block so `import/order` can sort it and the real startup order is the one
// visible below.
import { existsSync, readFileSync } from 'fs';
import netModule from 'net';
import { join } from 'path';

import { SyncEngine, ExtensionManager, createLogger, getEventBus, getLogLevel, setLogLevel, isConnectionError, raiseAutoSelectFamilyAttemptTimeout } from '@sarvinbox/core';
import { SQLiteStorage } from '@sarvinbox/storage-node';
import { app, BrowserWindow, Menu, ipcMain, powerMonitor, protocol, session, shell } from 'electron';

import { registerAllHandlers } from './ipc';
import { sendEmailFromMain, appendSentCopy } from './ipc/smtp-handlers';
import { buildViewMenu } from './menu/view-menu';
import { initSentryMain, captureFatal } from './sentry';
import {
  seedAccountRegistryFromDurableStores,
  getRegistryActiveAccountId,
  readRegistryAccounts,
  cleanupMigratedLegacyFiles,
  resolveAccountEmail,
} from './services/accounts-registry';
import {
  PRIMARY_DB_FILE,
  ensureAccountRuntime,
  loadPrimaryAccountId,
  savePrimaryAccountId,
  legacyDbExists,
  accountDbExists,
  cleanupOrphanedAccountDbs,
  cleanupStaleUserDataArtifacts,
} from './services/accounts-runtime';
import { loadAgentConfig } from './services/agent-config-store';
import { getAllAiSecrets } from './services/ai-secret-store';
import {
  ATTACHMENT_SCHEME_PRIVILEGES,
  registerAttachmentProtocol,
} from './services/attachment-protocol';
import { startAvatarDiscoveryScheduler, stopAvatarDiscoveryScheduler } from './services/avatar-discovery-scheduler';
import { startBackfillScheduler, stopBackfillScheduler } from './services/backfill-scheduler';
import { startBodyPrefetchScheduler, stopBodyPrefetchScheduler } from './services/body-prefetch-scheduler';
import { startBodyRehealScheduler, stopBodyRehealScheduler } from './services/body-reheal-scheduler';
import { startContactEnrichmentScheduler, stopContactEnrichmentScheduler } from './services/contact-enrichment-scheduler';
import { startConversationScheduler, stopConversationScheduler } from './services/conversation-extraction-scheduler';
import { backupCoreDb } from './services/core-db';
import { getDbEncryptionKey } from './services/db-key-store';
import { describeDevSessionReset, resetDevSessionCaches } from './services/dev-session-reset';
import { installEmailImageRequestHandlers } from './services/email-image-requests';
import { describeStall, startEventLoopMonitor } from './services/event-loop-monitor';
import { createExtensionAIBackend } from './services/extension-ai-backend';
import { createExtensionMailBackend } from './services/extension-mail-backend';
import { installSystemExtensions } from './services/extension-marketplace';
import {
  PANEL_SCHEME_PRIVILEGES,
  registerPanelProtocol,
} from './services/extension-panel-protocol';
import { createSandboxChannel } from './services/extension-runtime';
import { createExtensionUIBackend } from './services/extension-ui-backend';
import { startExtensionWorkflowRunner, stopExtensionWorkflowRunner } from './services/extension-workflow-runner';
import { wireFolderCountBroadcast } from './services/folder-count-broadcast';
import { startHeaderBackfill, stopHeaderBackfill } from './services/header-backfill';
import { ensureNativeSqliteLoadable } from './services/native-abi-guard';
import { startNotificationService, stopNotificationService } from './services/notification-service';
import { startOAuthRefreshScheduler, stopOAuthRefreshScheduler } from './services/oauth-refresh-scheduler';
import { initializeOAuth, abortInFlightTokenRefreshes } from './services/oauth-service';
import { initOutbox, stopOutbox, rebindOutboxStorage } from './services/outbox-service';
import { loadPipelineAIConfigSync } from './services/pipeline-ai-config-store';
import { startPipelineEventPersister, stopPipelineEventPersister } from './services/pipeline-event-persister';
import { attachReputation } from './services/reputation-service';
import { migrateSecureCredsFromFile } from './services/secure-credential-store';
import { startSenderIdentityScheduler, stopSenderIdentityScheduler } from './services/sender-identity-service';
import {
  defaultDevReclaimDeps,
  defaultHeartbeatDeps,
  defaultKillDeps,
  evaluateLockContention,
  reclaimPids,
  reclaimSingleDevInstance,
  startDevInstanceRecord,
  startHeartbeat,
  tagMainProcess,
} from './services/single-child';
import {
  decideSecondInstanceAction,
  isOrphanedFromLauncher,
  mainProcessTitle,
  shouldKillLauncherOnQuit,
  shouldTagMainProcess,
} from './services/single-instance';
import { SMOKE_TEST_OK_MARKER, readSmokeTestRequest, writeSmokeTestMarker } from './services/smoke-test';
import { startSnoozeChecker, stopSnoozeChecker } from './services/snooze-checker';
import { startSpamReputationScheduler, stopSpamReputationScheduler } from './services/spam-reputation-service';
import { startStartupThreadRepair, stopStartupThreadRepair } from './services/startup-thread-repair';
import { initializeUnifiedPipeline, stopUnifiedPipeline } from './services/unified-pipeline-service';
import { checkForUpdates, startUpdateService, stopUpdateService } from './services/update-service';
import {
  setMainWindow,
  getMainWindow,
  setStorage,
  setSyncEngine,
  setExtensionManager,
  setIsQuitting,
  getStorage,
  getSyncEngine,
  getAllAccountRuntimes,
  getSmtpClient,
  getExtensionManager,
  getAICategorizationService,
  getIsQuitting,
  getSystemSuspended,
  setSystemSuspended,
  getAccountIdForStorage,
  sendToWindow,
  setCurrentAccount,
  hasAccountRuntime,
} from './shared';
import { resolveAppIconPath } from './utils/app-icon';
import { initFileLogger, flushFileLogger, muteTerminalOutput, appendExternalLog } from './utils/file-logger';
import { loadDotEnv, defaultDotEnvPaths } from './utils/load-env';
import { classifyNavigation, type NavigationScope } from './utils/navigation-policy';

// App identity MUST be set before ANYTHING reads app.getPath('userData') —
// initSentryMain(), the file logger, and the DB key store all derive their paths
// (and the safeStorage keychain item) from app.name. Sentry in particular
// resolves userData at init, which LOCKS the path to the default "Sarv Inbox"
// before a dev name can be applied — that stranded dev logs/DB under the prod
// folder and, worse, made safeStorage try the wrong keychain master (decrypt
// failed). So this block runs first, before any userData consumer.
//
// Reliable dev detection: do NOT use `!app.isPackaged` alone — this dev setup
// runs a RENAMED Electron binary and Electron reports app.isPackaged === true for
// any renamed executable. vite-plugin-electron sets VITE_DEV_SERVER_URL only in
// dev, so that's the reliable signal; `|| !app.isPackaged` keeps a plain
// `electron .` run working too.
const isDev = !!process.env['VITE_DEV_SERVER_URL'] || !app.isPackaged;

// Tag THIS main process with a distinctive title (build-specific). A reclaim FINDS
// the previous instance by the pid it recorded under userData, never by this title;
// the title is one of the markers it verifies that pid against before signalling it,
// and it names our process for a human reading `ps`.
//
// Skipped on macOS entirely, where process.title doubles as the name AppKit draws in
// the menu bar -- it would show "sarvinbox-dev-main" instead of "Sarv Inbox Dev".
// See shouldTagMainProcess().
if (shouldTagMainProcess({ platform: process.platform })) {
  tagMainProcess(mainProcessTitle(isDev));
}

// The vite/pnpm launcher that spawned this dev process. Captured at module load,
// before Ctrl+C can re-parent us to launchd (pid 1). The ppid watchdog (installed
// in whenReady) compares the live ppid against this to self-quit when the launcher
// dies — so we don't even become the orphan the next launch has to reclaim.
const DEV_LAUNCHER_PID = process.ppid;

// DISTINCT dev identity so dev and an installed release DMG NEVER collide in any
// way. Setting app.name gives dev its own value for all three OS-scoped things at
// once: the userData dir ("~/Library/Application Support/Sarv Inbox Dev"), the
// macOS menu name, AND the safeStorage keychain item ("Sarv Inbox Dev Safe
// Storage") that encrypts the DB key / credential vault / OAuth tokens. The
// packaged build keeps the real "Sarv Inbox". (Bundle id is separated too — see
// scripts/postinstall.mjs, which stamps com.sarv.sarvinbox.dev on the dev binary.)
const APP_NAME = isDev ? 'Sarv Inbox Dev' : 'Sarv Inbox';
app.name = APP_NAME;

// Windows requires an explicit AppUserModelID for toast notifications to show
// (and to group under the right taskbar identity). Harmless no-op on macOS/Linux.
app.setAppUserModelId(isDev ? 'com.sarv.sarvinbox.dev' : 'com.sarv.sarvinbox');

// Load local .env (gitignored) into process.env before anything reads it, so
// OAuth secrets / dev overrides are available without exporting them by hand.
loadDotEnv(defaultDotEnvPaths());

// Release builds default to INFO — the logger's built-in default is 'debug' (so
// the IMAP command + pool trace is visible in dev without any config), but that
// floods a shipped app's app.log (tens of thousands of "Pool: acquired…" lines).
// Dev stays at debug; an explicit SARV_LOG_LEVEL (env or .env) always wins.
if (!isDev && !process.env['SARV_LOG_LEVEL']) {
  setLogLevel('info');
}

// Initialize crash/error reporting as early as possible, before any app work.
initSentryMain();

// The in-app attachment viewer's scheme. MUST be declared at module scope:
// Electron only accepts privileged-scheme registration before `app.whenReady()`,
// and a scheme registered late silently loses `stream`/`secure` — the symptom is
// a PDF that never paints and a video that cannot seek, with no error anywhere.
// The handler itself is installed inside whenReady (see registerAttachmentProtocol).
//
// And it MUST come AFTER initSentryMain(). Electron does not merge repeated
// registrations: each call REPLACES the per-privilege scheme lists it names. The
// Sentry SDK registers its own `sentry-ipc` scheme during init and, knowing this,
// proxies `registerSchemesAsPrivileged` so that every LATER call carries its
// scheme along — but a call made BEFORE it is simply overwritten. Registering
// first left the renderer with `--standard-schemes=sarv-attachment` and
// `--secure-schemes/--cors-schemes/--fetch-schemes=sentry-ipc`: attachments kept
// the privileges nothing else claimed and lost the three Sentry also wanted. The
// visible result was that `<img>`/`<video>`/the PDF viewer worked while the text
// pane's `fetch()` failed with "Failed to fetch" before the handler ever ran.
// Registered in the same call as the attachment scheme, not a second one:
// Electron REPLACES the per-privilege scheme lists on every call rather than
// merging them, so a separate registration here would silently strip the
// attachment scheme's privileges (see the note above).
protocol.registerSchemesAsPrivileged([ATTACHMENT_SCHEME_PRIVILEGES, PANEL_SCHEME_PRIVILEGES]);
const logger = createLogger('main');

// Give every outbound connection from the main process a fair chance at its
// FIRST address before Node races the next one. Node's 250ms default turns an
// ordinary 300ms handshake into `ETIMEDOUT` on any dual-stack host when the
// machine has no working IPv6 — which is how a Gmail account stops refreshing
// its OAuth token on a link where `curl` to the same URL works fine. Process-
// wide, so IMAP/SMTP and every fetch get it too. See connect-timeout.ts.
// Raised HERE, before anything can connect; reported further down, once the
// app.log sink exists (a line logged this early reaches the terminal only).
const connectWindow = raiseAutoSelectFamilyAttemptTimeout({
  get: () => netModule.getDefaultAutoSelectFamilyAttemptTimeout(),
  set: (ms) => netModule.setDefaultAutoSelectFamilyAttemptTimeout(ms),
});

// Read version from package.json
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
const APP_VERSION = packageJson.version;

// Stop every background timer that touches storage. Must run before
// storage.close() on shutdown, otherwise pending ticks hit a closed DB
// and log "Storage not initialized". Idempotent — safe to call twice.
let backgroundTimersStopped = false;
// The one teardown step that is asynchronous (a final DB write). Awaited by
// awaitBackgroundTimerShutdown() on the quit path; ignored elsewhere, where
// losing a buffered log batch is acceptable.
let pendingPersisterFlush: Promise<void> | null = null;

/** Await the async part of stopBackgroundTimers(). Safe to call more than once. */
async function awaitBackgroundTimerShutdown(): Promise<void> {
  const pending = pendingPersisterFlush;
  pendingPersisterFlush = null;
  if (pending) await pending.catch(() => { /* shutdown: never block on a log write */ });
}

function stopBackgroundTimers(): void {
  if (backgroundTimersStopped) return;
  backgroundTimersStopped = true;
  try { stopSnoozeChecker(); } catch {}
  try { stopConversationScheduler(); } catch {}
  try { stopContactEnrichmentScheduler(); } catch {}
  try { stopBodyPrefetchScheduler(); } catch {}
  try { stopHeaderBackfill(); } catch {}
  try { stopBackfillScheduler(); } catch {}
  try { stopStartupThreadRepair(); } catch {}
  try { stopAvatarDiscoveryScheduler(); } catch {}
  try { stopSenderIdentityScheduler(); } catch {}
  try { stopSpamReputationScheduler(); } catch {}
  try { stopBodyRehealScheduler(); } catch {}
  // Returns a promise: its final flush is a DB write, so the shutdown path must
  // await it or the last batch of pipeline events dies in the buffer. Captured
  // here (this function is sync and called from several places) and awaited by
  // the async teardown below via awaitBackgroundTimerShutdown().
  try { pendingPersisterFlush = stopPipelineEventPersister(); } catch {}
  try { stopUnifiedPipeline(); } catch {}
  try { stopNotificationService(); } catch {}
  try { stopUpdateService(); } catch {}
  try { stopOAuthRefreshScheduler(); } catch {}
  try { getAICategorizationService()?.stopAutoProcess(); } catch {}
}

logger.info('==============================================');
logger.info('[Main] Sarv Inbox Version:', APP_VERSION);
logger.info('==============================================');

// Application menu.
//
// Built on EVERY platform, not just macOS as it once was: the only route to
// "Check for Updates" is a menu item, and leaving Windows and Linux on
// Electron's stock menu meant those users had no way to reach it. macOS also
// needs a custom menu to show the app name instead of "Electron" in dev.
// The View menu's zoom items route through the renderer so Cmd +/- edits the
// SAME persisted zoom the Appearance tab shows, instead of Electron's own
// frame zoom that is forgotten on the next launch. See menu/view-menu.ts.
const viewMenu = buildViewMenu((clickedWindow, command) => {
  // A menu click reports a BaseWindow, which has no webContents. Resolve it to
  // the BrowserWindow it belongs to, and fall back to the focused/only window
  // for the macOS case where the menu is up with no window clicked.
  const target =
    (clickedWindow ? BrowserWindow.fromId(clickedWindow.id) : null) ??
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows()[0];
  target?.webContents.send('appearance:zoom-command', command);
});

const checkForUpdatesItem: Electron.MenuItemConstructorOptions = {
  // The ellipsis is the platform convention for "this opens something".
  label: 'Check for Updates...',
  click: () => {
    // Fire-and-forget: the result reaches the renderer as a pushed state, and
    // the dialog is what reports back. A rejection here is already logged and
    // surfaced as the 'error' phase, so there is nothing to await.
    void checkForUpdates('manual');
  },
};

if (process.platform === 'darwin') {
  const appMenu: Electron.MenuItemConstructorOptions = {
    label: APP_NAME,
    submenu: [
      { role: 'about', label: `About ${APP_NAME}` },
      // macOS convention puts this in the app menu, directly under About,
      // rather than in Help where Windows and Linux expect it.
      checkForUpdatesItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide', label: `Hide ${APP_NAME}` },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit', label: `Quit ${APP_NAME}` },
    ],
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      appMenu,
      { role: 'fileMenu' },
      { role: 'editMenu' },
      viewMenu,
      { role: 'windowMenu' },
    ]),
  );
} else {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'fileMenu' },
      { role: 'editMenu' },
      viewMenu,
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          checkForUpdatesItem,
          { type: 'separator' },
          { role: 'about', label: `About ${APP_NAME}` },
        ],
      },
    ]),
  );
}

// Disable security warnings in development
process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true';

// Increase Node.js memory limit to 2GB.
// Opt-in diagnostic: set SARV_PROFILE=1 (dev only) to also turn on V8's tick
// profiler (--prof). Use it to find a synchronous main-thread CPU hog (a
// renderer freeze / beachball): the switch propagates to renderer processes
// too, so each isolate writes v8prof-<pid>.log into the app's userData dir,
// readable with `node --prof-process`. Off by default — zero overhead unless
// the env var is set. Requires a full app restart (V8 reads --prof at startup).
const V8_PROFILE =
  isDev && process.env['SARV_PROFILE']
    ? ` --prof --logfile=${join(app.getPath('userData'), 'v8prof-%p.log')}`
    : '';
app.commandLine.appendSwitch('js-flags', `--max-old-space-size=2048${V8_PROFILE}`);

// Suppress EGL/GPU driver error messages
app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('log-level', '3');

// App paths
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'] || (isDev ? 'http://localhost:5173' : null);

// Tee the main-process console to a rolling app.log (dev AND release).
initFileLogger();
// Renderer logs → the SAME app.log (redacted in appendExternalLog), so a bug
// report's log file carries the renderer's trail too — not just DevTools. The
// renderer forwards fire-and-forget (ipcRenderer.send), and its own level gate
// (set in bootstrap/renderer-logging.ts) decides what's forwarded, so trace/debug
// stay off in release. Registered right after the sink exists so nothing is lost.
ipcMain.on('log:forward', (_e, rec: { level?: string; name?: string; text?: string } | undefined) => {
  if (rec && typeof rec.text === 'string') {
    appendExternalLog('renderer', rec.level ?? 'info', rec.name ?? '?', rec.text);
  }
});
// Announce the active log level up front so it's obvious in app.log what will
// (and won't) be captured — e.g. the IMAP command trace only shows at 'debug'.
logger.info(`Log level: ${getLogLevel()} (override with SARV_LOG_LEVEL=trace|debug|info|warn|error)`);
if (connectWindow.changed) {
  logger.info(`[Net] per-address connect window ${connectWindow.from}ms -> ${connectWindow.to}ms (Node's default abandons a slow first address and fails as ETIMEDOUT)`);
}

// Suppress connection errors (normal network issues)
process.on('uncaughtException', (error: any) => {
  const isConnectionError = error.message?.includes('ECONNRESET') ||
                            error.message?.includes('EPIPE') ||
                            error.message?.includes('ETIMEDOUT') ||
                            error.message?.includes('ECONNREFUSED') ||
                            error.code === 'ECONNRESET' ||
                            error.code === 'EPIPE' ||
                            error.code === 'ETIMEDOUT' ||
                            error.code === 'ECONNREFUSED' ||
                            error.code === 'CONNECTION_ERROR';

  if (getIsQuitting() || isConnectionError) {
    return;
  }
  logger.error('Uncaught exception:', error);
  // Report the crash to Sentry (best-effort flush inside), THEN force the pino
  // buffer to disk so the local app.log keeps the last lines even if we die.
  captureFatal(error, 'uncaughtException');
  flushFileLogger();
});

process.on('unhandledRejection', (reason: any) => {
  // Reuse the SHARED connection-error classifier (imap-errors.ts) instead of a
  // hand-rolled subset. The old inline list only matched ECONNRESET/EPIPE/etc.,
  // so a transient IMAP drop that surfaces as "Connection not available" (ImapFlow
  // code NoConnection), "Not connected", "Unexpected close" or an op timeout — all
  // benign, the reconnect ladder recovers — slipped through and got logged FATAL +
  // shipped to Sentry as a false alarm (seen on startup against a wedged server).
  if (getIsQuitting() || isConnectionError(reason)) {
    return;
  }
  logger.error('Unhandled rejection:', reason);
  captureFatal(reason, 'unhandledRejection');
  flushFileLogger();
});

/**
 * Create main window
 */
function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    center: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Chromium OS sandbox ON: a compromised renderer (e.g. via malicious email
      // HTML) is confined to the process and can only reach main through the
      // explicit contextBridge IPC. Safe here because the bundled preload only
      // `require("electron")` (contextBridge/ipcRenderer) — no fs/os/stream/etc.,
      // which the sandbox would forbid. If a future preload dep pulls a Node
      // builtin, the app blank-screens at launch and this must go back to false.
      sandbox: true,
      // Chromium's built-in PDF viewer is a plugin; without this an <iframe>
      // pointing at a PDF downloads instead of rendering, which is the exact
      // behaviour the in-app viewer exists to remove. This does NOT widen the
      // email-content surface: the sandboxed email-body iframe runs under
      // `default-src 'none'`, which already blocks <embed>/<object>.
      plugins: true,
    },
    title: 'Sarv Inbox',
    show: false,
    icon: resolveAppIconPath(__dirname, isDev),
  });

  setMainWindow(mainWindow);

  // Load URL
  if (VITE_DEV_SERVER_URL) {
    // The cache reset must NEVER gate navigation. The window is `show: false`
    // until 'ready-to-show', which only fires once a page loads — so a clear that
    // never settles leaves a permanently invisible window with no error and no
    // log line (it has happened). resetDevSessionCaches never rejects and never
    // outlives its deadline, so this .then() always runs and always navigates.
    void resetDevSessionCaches({
      clearCache: () => session.defaultSession.clearCache(),
      clearStorageData: () => session.defaultSession.clearStorageData({
        storages: ['cachestorage', 'shadercache', 'serviceworkers'],
      }),
    }).then((outcome) => {
      const message = describeDevSessionReset(outcome);
      if (outcome === 'cleared') logger.info(message);
      else logger.warn(message);
      const url = `${VITE_DEV_SERVER_URL}?t=${Date.now()}`;
      mainWindow.loadURL(url).catch((err) => {
        logger.error('[Main] Failed to load URL:', err);
      });
    });
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      logger.error('[Main] Page failed to load:', errorCode, errorDescription);
    });
  } else {
    mainWindow.loadFile(join(__dirname, '../dist/index.html'));
  }

  // Open all external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Both guards below share one decision (electron/utils/navigation-policy.ts)
  // so a rule can never be added to one and forgotten in the other.
  const applyNavigationPolicy = (event: Electron.Event, url: string, scope: NavigationScope) => {
    const verdict = classifyNavigation(url, VITE_DEV_SERVER_URL || 'file://', scope);
    if (verdict === 'allow') return;
    event.preventDefault();
    if (verdict === 'external') {
      shell.openExternal(url).catch((err) => logger.warn('[Main] openExternal failed:', err));
    } else {
      logger.warn(`[Main] Blocked ${scope}-level navigation to an unsupported scheme:`, url);
    }
  };

  mainWindow.webContents.on('will-navigate', (event, url) => {
    applyNavigationPolicy(event, url, 'top');
  });

  // Same rule for a navigation started INSIDE a frame. `will-navigate` fires
  // for the top-level frame only, so an email body's iframe could navigate
  // itself to a remote page and render it inside the inbox — the sandbox
  // (`allow-same-origin allow-popups`, no `allow-top-navigation`) stops it
  // taking over the window but not from replacing its own content. The renderer
  // rewrites anchors to target="_blank" so they route through the
  // setWindowOpenHandler above, and it also intercepts clicks at runtime; this
  // is the backstop that cannot be raced or bypassed by markup neither of those
  // anticipated. Guarded because `will-frame-navigate` is Electron 25+.
  if (typeof (mainWindow.webContents as { on?: unknown }).on === 'function') {
    try {
      mainWindow.webContents.on('will-frame-navigate' as never, ((event: Electron.Event, url: string) => {
        applyNavigationPolicy(event, url, 'frame');
      }) as never);
    } catch (err) {
      logger.warn('[Main] will-frame-navigate unavailable on this Electron:', err);
    }
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // Open DevTools AFTER the window is visible, docked to the right. Opening it
    // earlier (during createWindow, while the window is still `show: false`)
    // docked into a not-yet-visible window, so it never appeared. Docked mode
    // (not the remembered 'detach' state) keeps it reliably on-screen in dev.
    if (VITE_DEV_SERVER_URL) {
      mainWindow.webContents.openDevTools({ mode: 'right' });
    }
  });

  mainWindow.on('closed', () => {
    setMainWindow(null);
  });
}

/**
 * Initialize storage
 */
async function initializeStorage(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const dbPath = join(userDataPath, PRIMARY_DB_FILE);

  // LEGACY SUPPORT ONLY: open sarvinbox.db when it already exists (an existing
  // install's primary account lives here). NEVER create it for a fresh install —
  // new users, and every account once the legacy one is removed, get their own
  // sarvinbox-<hash(id)>.db (see accounts-runtime). Leaving storage unset here
  // is fine: the pre-account state already has no active storage, and each
  // account's runtime is created on activation.
  if (!existsSync(dbPath)) {
    logger.info('[Main] No legacy sarvinbox.db — accounts will use per-id databases');
    return;
  }

  const storage = new SQLiteStorage({
    dbPath,
    readonly: false,
    verbose: false,
    key: getDbEncryptionKey(),
    // The legacy primary DB gets the larger page cache. Per-id account DBs
    // (accounts-runtime) get the modest default so N accounts don't multiply
    // into a huge footprint.
    cacheSizeKb: 32768, // 32 MB
  });

  await storage.initialize();
  setStorage(storage);
  // Same wiring as the per-account runtimes: a badge the drain repairs must
  // reach the sidebar without waiting for the user's next action.
  wireFolderCountBroadcast(storage, {
    send: sendToWindow,
    accountId: () => getAccountIdForStorage(storage),
  });
  logger.info('[Main] Storage initialized:', dbPath);
}

/**
 * Seed the durable accounts registry and AUTO-ACTIVATE the persisted active
 * account — independent of the renderer.
 *
 * Two bugs this closes:
 *   1. An OAuth account (e.g. Gmail) vanished when renderer localStorage was
 *      lost. Seeding the registry from the durable main-side stores means the
 *      account list survives with no localStorage at all.
 *   2. The app bricked with "Storage not initialized" when the renderer booted
 *      without an active-account pointer, because main deferred all storage init
 *      to the renderer's activation. Activating the persisted account here makes
 *      main self-sufficient.
 *
 * Best-effort: any failure is logged and the renderer's own flow still runs.
 */

async function initializeAccountRegistry(): Promise<void> {
  try {
    // Seed accounts from the durable secret stores. This also TRIGGERS the
    // file→core-DB migration of oauth-accounts.json + imap-account.json + the
    // primary pointer (they migrate on first read).
    await seedAccountRegistryFromDurableStores();
  } catch (e) {
    logger.warn('[Main] Account registry seed failed:', (e as Error)?.message);
  }

  // The credential vault isn't read during seed (only on connect/reveal), so
  // force its file→DB migration now, before the legacy-file cleanup below.
  try {
    await migrateSecureCredsFromFile();
  } catch (e) {
    logger.warn('[Main] Secure-credentials migration deferred (keychain locked?):', (e as Error)?.message);
  }

  // The last three standalone settings/secret stores (agent config, AI API keys,
  // pipeline AI config) migrate file→core-DB on first read. Force those reads NOW
  // — write-to-DB FIRST — so the legacy-file cleanup below removes their JSONs in
  // THIS startup instead of the next. Best-effort; each read no-ops when already
  // migrated or absent.
  try {
    loadAgentConfig();
    loadPipelineAIConfigSync();
    await getAllAiSecrets();
  } catch (e) {
    logger.warn('[Main] settings→core-DB migration deferred:', (e as Error)?.message);
  }

  // Remove legacy JSON files whose data is now verified-present in the core DB
  // (oauth tokens, vault, imap config, primary pointer). Safe + idempotent —
  // deletion is gated on the migrated blob/meta actually existing.
  try {
    const removedFiles = cleanupMigratedLegacyFiles();
    if (removedFiles.length) logger.info(`[Main] Removed ${removedFiles.length} migrated legacy file(s):`, removedFiles.join(', '));
  } catch (e) {
    logger.warn('[Main] Legacy file cleanup failed:', (e as Error)?.message);
  }

  // Sweep orphaned per-account DB files EVERY startup — cheap (one readdir), and
  // self-healing (an orphan left by a rekey/removal-crash gets cleaned on the next
  // launch instead of lingering forever behind a one-time flag). The keep-set
  // comes from `readRegistryAccounts`, which THROWS rather than reporting an
  // unreadable registry as an empty one: this sweep deletes files, so "I could
  // not read the registry" must abort it, not license it. It once did the
  // opposite — a native-module load failure made the registry read fail, the
  // swallowing `listRegistryAccounts` returned [], and the sweep deleted both
  // live mailbox DBs as orphans. A live account's DB is never touched, and the
  // staleness guard (default 1h) is only the LAST safety, not the first.
  try {
    const keepAccountIds = readRegistryAccounts().map((a) => a.id);
    const removed = cleanupOrphanedAccountDbs({ keepAccountIds });
    if (removed.length) logger.info(`[Main] Cleaned ${removed.length} orphaned DB file(s):`, removed.join(', '));
  } catch (e) {
    logger.error('[Main] Orphaned DB cleanup SKIPPED — the account registry could not be read, so nothing was deleted:', (e as Error)?.message);
  }

  // Sweep stale NON-DB leftovers too (a dead debug log, orphaned bundle-id temp
  // files). Staleness-guarded so a live file is never removed. Sentry's dir and
  // the app logs are deliberately left alone.
  try { cleanupStaleUserDataArtifacts(); } catch (e) {
    logger.warn('[Main] Stale-artifact cleanup failed:', (e as Error)?.message);
  }

  // Back up the core DB (now the crown jewels) after seed + migrations, so a
  // corrupted core.db is recoverable from sarvinbox-core.db.bak.
  try { backupCoreDb(); } catch { /* best-effort */ }

  try {
    const activeId = getRegistryActiveAccountId();
    if (!activeId) return;

    // Mirror accounts:setActive's legacy-adopt rule: the FIRST account to
    // activate claims the existing sarvinbox.db (only when it already exists);
    // fresh installs never create it and use per-id DBs.
    if (!loadPrimaryAccountId() && legacyDbExists()) savePrimaryAccountId(activeId);

    // Only activate when the account's DB can be resolved — the recorded primary
    // (legacy sarvinbox.db) or an existing per-id DB. Never spin up a blank
    // mailbox for an id whose data isn't on disk.
    const isPrimary = loadPrimaryAccountId() === activeId && legacyDbExists();
    if (!isPrimary && !accountDbExists(activeId)) {
      logger.info('[Main] Persisted active account has no DB yet — deferring to renderer:', activeId);
      return;
    }

    setCurrentAccount(activeId);
    if (!hasAccountRuntime(activeId)) await ensureAccountRuntime(activeId);
    rebindOutboxStorage();
    logger.info('[Main] Auto-activated persisted account:', activeId);
  } catch (e) {
    logger.warn('[Main] Auto-activate persisted account failed:', (e as Error)?.message);
  }
}

/**
 * Disconnect EVERY account's IMAP engine — the active one AND all background
 * accounts — fully closing the primary connection, the connection POOL, and IDLE
 * (SyncEngine.disconnect does all three). Deduped so the active engine (also in
 * the runtimes) isn't torn down twice. Best-effort.
 *
 * Shared by graceful shutdown AND system-suspend: leaving live sockets frozen by
 * sleep makes the server keep counting them against its per-account cap
 * (Gmail = 15), so on wake the fresh connections tip over the cap ("Too many
 * simultaneous connections"). Closing them before sleep prevents that.
 */
async function disconnectAllImapEngines(): Promise<void> {
  const engines = new Set<any>();
  const active = getSyncEngine();
  if (active) engines.add(active);
  for (const [, rt] of getAllAccountRuntimes()) if (rt.syncEngine) engines.add(rt.syncEngine);
  await Promise.allSettled([...engines].map(async (eng) => {
    try {
      eng.getClient?.()?.setShuttingDown?.();
      await eng.disconnect?.();
    } catch { /* best-effort */ }
  }));
}

/**
 * Initialize sync engine
 */
async function initializeSyncEngine(): Promise<void> {
  const storage = getStorage();
  if (!storage) {
    // Fresh install with no legacy sarvinbox.db — there's no startup storage to
    // wrap. Each account's own SyncEngine is created with its per-id DB when the
    // account is activated (accounts-runtime), so nothing is needed here yet.
    logger.info('[Main] No startup storage — sync engine deferred to first account activation');
    return;
  }

  const syncEngine = new SyncEngine(storage);
  attachReputation(syncEngine);
  setSyncEngine(syncEngine);
  logger.info('[Main] Sync engine initialized');
}

/**
 * Initialize extension manager
 */
async function initializeExtensionManager(): Promise<void> {
  const userDataPath = app.getPath('userData');
  const extensionsBaseDir = join(userDataPath, 'extensions-data');

  // No extensions are compiled into the app. They live in their own repository
  // (https://github.com/Sarv/SarvInbox-extensions), are published as signed-
  // by-checksum release archives, and are installed into `extensionsBaseDir`
  // like any other — including the ones `extensions.config.json` names as
  // system extensions, which are simply installed for the user on first run.
  // That keeps one code path for a shipped extension and a user-installed one.
  const aiBackend = createExtensionAIBackend();

  const extensionManager = new ExtensionManager({
    extensionsBaseDir,
    aiBackend,
    // The GLOBAL bus, not a private one. Without this the manager created its
    // own, so an extension subscribing to `email:synced` heard nothing the sync
    // pipeline ever published — the events existed, on a different bus.
    eventBus: getEventBus(),
    uiBackend: createExtensionUIBackend(),
    // Reading and changing mail on the extension's own schedule, each method
    // gated on the permission the reader approved at install time.
    mailBackend: createExtensionMailBackend(),
    // Extension code runs in its own process, not this one. Main keeps the
    // database key, the credential vault and the IMAP connections; the sandbox
    // gets a message port and has to ask for everything else.
    createChannel: createSandboxChannel,
  });

  try {
    await extensionManager.initialize();
    setExtensionManager(extensionManager);
    // Only after the manager is registered: the runner reads it through the
    // shared accessor on every event, and starting first would drop whatever
    // arrived in between.
    startExtensionWorkflowRunner();
    logger.info('[Main] Extension manager initialized with AI backend');

    // Deliberately not awaited: seeding a new profile can involve a registry
    // fetch, and startup must not wait on the network. Anything already
    // installed is left alone, so this is a no-op on every run but the first.
    void installSystemExtensions().catch((error) => {
      logger.warn('[Main] Could not install the default extensions:', error);
    });
  } catch (error) {
    logger.error('[Main] Failed to initialize extension manager:', error);
  }
}

/**
 * The folder `sarv-extension://<id>/...` is allowed to serve from, or undefined
 * when that extension may not show panels.
 *
 * Re-read on every request rather than captured once, so disabling an extension
 * or revoking `ui:panel` takes effect on the next asset it asks for instead of
 * at the next restart.
 */
function resolvePanelExtensionDir(extensionId: string): string | undefined {
  const installed = getExtensionManager()?.getRegistry().get(extensionId);
  if (!installed || !installed.enabled) return undefined;
  if (!installed.grantedPermissions.includes('ui:panel')) return undefined;
  return installed.path;
}

// ========== Single-instance lock ==========
//
// Guarantee only ONE Sarv Inbox process runs per user. Two instances would each
// stand up their own IMAP pool + IDLE connections against the SAME account,
// doubling our footprint against the provider's per-account connection cap
// (Gmail ~15) — the exact "too many simultaneous connections" failure we fight.
// The FIRST process to launch owns the lock; any later launch (double-click,
// `open -n`, a dock/taskbar re-click, a deep link) is handed to it and exits.
//
// requestSingleInstanceLock() must run before the app is ready. If we don't get
// the lock, another instance already owns it: exit immediately with app.exit(0)
// — NOT app.quit(), which would fire the before-quit IMAP/DB teardown against
// state this duplicate never initialized — so a duplicate never touches storage
// or opens a single connection.
//
// DEV ONLY exception: vite-plugin-electron hot-restart kills the old main
// process and spawns a new one, and our SIGTERM teardown holds the lock for up
// to ~3s while it drains. The new process would lose the race for the lock and
// exit, killing the dev app until the next edit. So the lock is enforced for
// packaged/shipped builds only — where the duplicate-connection risk is real.
let gotSingleInstanceLock = isDev ? true : app.requestSingleInstanceLock();

// PROD wedged-primary recovery. Failing to get the lock means a LIVE holder exists
// right now. The lock alone can't tell a HEALTHY holder (which will surface its
// window via 'second-instance' — we just exit) from a WEDGED one (a beachballed
// main thread that keeps the lock but can't process events, locking the user out).
// So before exiting we consult the holder's liveness heartbeat: only when it is
// provably stale AND alive AND verified as our own app do we kill it and retry the
// lock once. Every uncertain case defers → app.exit(0), i.e. exactly today's
// behavior — this path can only ever be safer, never worse. Async, so whenReady
// awaits `singleInstanceReady` before trusting `gotSingleInstanceLock`.
const singleInstanceReady: Promise<void> = (async () => {
  if (isDev || gotSingleInstanceLock) return;
  try {
    const { action, holderPid } = evaluateLockContention(
      defaultHeartbeatDeps(app.getPath('userData'), app.getName()),
    );
    if (action === 'reclaim' && holderPid) {
      logger.warn(`[Main] existing instance (pid=${holderPid}) is not responding — reclaiming its lock.`);
      await reclaimPids([holderPid], process.pid, defaultKillDeps(logger));
      // The wedged holder is dead → its lock is now stale → this re-request takes it.
      gotSingleInstanceLock = app.requestSingleInstanceLock();
      if (gotSingleInstanceLock) {
        logger.info('[Main] reclaimed the single-instance lock from the wedged primary.');
      }
    }
  } catch (err) {
    logger.warn('[Main] lock-contention evaluation failed (deferring to existing instance):', err);
  }
  if (!gotSingleInstanceLock) {
    logger.info('[Main] Another Sarv Inbox instance is already running — exiting this duplicate.');
    app.exit(0);
  }
})();

// Fired in whichever process holds the lock when a second launch is attempted.
// Surface the existing window instead of spinning up a second process; recreate it
// if it was closed (macOS keep-alive) OR if it exists but its renderer CRASHED /
// was destroyed — focusing a dead frame would leave the user staring at a corpse.
app.on('second-instance', () => {
  const existing = getMainWindow();
  const windowUsable = !!existing
    && !existing.isDestroyed()
    && !!existing.webContents
    && !existing.webContents.isCrashed();
  const action = decideSecondInstanceAction({ hasWindow: !!existing, windowUsable, isReady: app.isReady() });
  if (action === 'focus' && existing) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  } else if (action === 'create') {
    createWindow();
  }
});

// ========== App Lifecycle ==========

// Stops the main-thread stall detector. Declared BEFORE the whenReady handler
// that assigns it — a `let` below its use sits in the temporal dead zone and
// throws ReferenceError from inside whenReady, taking the whole app down.
let stopEventLoopMonitor: (() => void) | null = null;

app.whenReady().then(async () => {
  // Wait for the (async) single-instance decision to settle — a prod duplicate may
  // still be evaluating whether the current holder is wedged and reclaimable.
  await singleInstanceReady;
  // A duplicate instance failed to get (or reclaim) the single-instance lock and is
  // already exiting (app.exit above); never initialize storage or open any
  // connection from it. whenReady still resolves in that process before it tears
  // down, so this guard is what actually prevents the duplicate footprint.
  if (!gotSingleInstanceLock) return;
  try {
    // PROD: now that we own the lock, publish our liveness heartbeat so the NEXT
    // launch can tell us apart from a wedged primary (see evaluateLockContention).
    // Stopped + removed on teardown. Dev has no lock, so no heartbeat.
    if (!isDev) {
      stopHeartbeatWriter = startHeartbeat(app.getPath('userData'));
    }

    // DEV single-child guarantee. BEFORE opening the DB or any IMAP connection,
    // kill any previous dev instance (a Ctrl+C orphan still holding Gmail
    // connections) so this run never stacks connections on top of it — the root of
    // the "two apps" + connect-timeout/back-off/beachball cycle. Bounded by the
    // reclaim's own grace window; must not block startup indefinitely.
    if (isDev) {
      try {
        await reclaimSingleDevInstance(defaultDevReclaimDeps(logger, app.getPath('userData')));
      } catch (err) {
        logger.warn('[Main] dev reclaim failed (continuing):', err);
      }
      // Only now record OUR pid: written any earlier it would overwrite the very
      // record the reclaim above had to read. Removed on teardown, so a leftover
      // file means the previous run died without one -- exactly the orphan case.
      stopDevInstanceRecord = startDevInstanceRecord(app.getPath('userData'));
      // Self-quit if our launcher (vite/pnpm) dies, so a killed `pnpm dev` doesn't
      // leave us orphaned in the dock. Responsive backstop to the reclaim above;
      // won't false-fire on vite hot-restart (the new child keeps the same ppid).
      const orphanWatchdog = setInterval(() => {
        if (isOrphanedFromLauncher(DEV_LAUNCHER_PID, process.ppid)) {
          logger.warn('[Main] dev launcher gone (orphaned) — quitting to avoid a stale second instance.');
          clearInterval(orphanWatchdog);
          app.quit();
        }
      }, 1000);
      orphanWatchdog.unref?.();
    }

    // Set dock icon for macOS
    if (process.platform === 'darwin' && app.dock) {
      try {
        app.dock.setIcon(resolveAppIconPath(__dirname, isDev));
      } catch {
        // Ignore - app will use default icon from bundle
      }
    }

    // Everything that has to happen at the network layer for the images in an
    // email to appear: unwrap sender-chosen image proxies, send a referer hosts
    // will accept, and drop the cross-origin embedding blocks Chromium honours.
    // Without these, whole newsletters render with broken pictures.
    installEmailImageRequestHandlers(session.defaultSession.webRequest);

    // BEFORE anything opens a database: prove the native SQLite module actually
    // loads in this process. It dlopens lazily and every core-DB read swallows
    // the failure into an empty result, so a mismatched ABI does not look like
    // an error — it looks like a fresh install with no accounts and no mail.
    // Stop with a named message instead of booting into that.
    if (!ensureNativeSqliteLoadable()) return;

    // CI smoke gate. The packaged app has now started for real and proved it can
    // load its native SQLite module on this machine, which is everything the
    // release checks could not see by reading the artifact. Stop here rather
    // than opening databases, keychains and sockets on a build runner.
    const smokeTest = readSmokeTestRequest(process.env, process.argv);
    if (smokeTest.enabled) {
      writeSmokeTestMarker(smokeTest.markerFile);
      logger.info(`[Main] ${SMOKE_TEST_OK_MARKER} — packaged app booted and loaded better-sqlite3.`);
      app.exit(0);
      return;
    }

    // Initialize core services
    await initializeStorage();
    // After storage, because the handler reads the email row to authorize each
    // request; before the window loads, so the first render can already fetch.
    // Given the SAME url the window loads, so the handler allows exactly our own
    // renderer's origin to fetch attachment bytes and nothing else.
    registerAttachmentProtocol(VITE_DEV_SERVER_URL ?? `file://${join(__dirname, '../dist/index.html')}`);
    await initializeSyncEngine();
    // Seed the durable accounts registry + auto-activate the persisted account
    // so main is self-sufficient (survives a lost renderer localStorage and
    // never bricks on "Storage not initialized"). Must run AFTER storage init.
    await initializeAccountRegistry();
    await initializeExtensionManager();
    // After the manager, because the handler asks it which extensions may serve
    // panels at all. The lookup is evaluated per request, so an extension
    // disabled later stops serving immediately.
    registerPanelProtocol(
      VITE_DEV_SERVER_URL ?? `file://${join(__dirname, '../dist/index.html')}`,
      resolvePanelExtensionDir
    );

    // Start background services
    startSnoozeChecker();
    startConversationScheduler();
    startContactEnrichmentScheduler();
    startBodyPrefetchScheduler();
    startHeaderBackfill();
    startBackfillScheduler();
    startStartupThreadRepair();
    startAvatarDiscoveryScheduler();
    startSenderIdentityScheduler();
    startSpamReputationScheduler();
    startBodyRehealScheduler();
    startPipelineEventPersister();
    startNotificationService();
    // Hourly check for a newer published release, plus the background
    // download that makes "Install and Relaunch" instant. No-ops on an
    // unpackaged build and on Linux distro packages - see update-policy.ts.
    startUpdateService();
    // Resolve who "we" are via the single shared identity resolver (registry
    // first, legacy accounts table as fallback — NEVER an arbitrary Sent
    // from_address, which used to pick vendor/no-reply senders). On connect,
    // sync-handlers additionally sets it from the live IMAP username.
    const userEmail = resolveAccountEmail(getStorage());
    logger.info(`[Main] Pipeline userEmail: "${userEmail || '(none)'}"`);
    // Restore the persisted AI Assist state so it survives a restart. Default
    // is OFF (empty store) — an install that never turned AI Assist on stays
    // off; but once the user enables it, new mail keeps auto-categorizing
    // across restarts without having to re-open the settings tab. DB-derived
    // userEmail wins over any stale persisted copy (spread order).
    const persistedAgentConfig = loadAgentConfig();
    initializeUnifiedPipeline({ ...persistedAgentConfig, enabled: persistedAgentConfig.enabled ?? false, userEmail });

    // Load OAuth client IDs from env (see OAUTH_SETUP.md).
    initializeOAuth();
    // Proactively keep OAuth access tokens fresh (per-account timer at ~75% of
    // token lifetime) so they never expire during idle — independent of connect
    // activity. Fire-and-forget; it self-schedules per account.
    void startOAuthRefreshScheduler();

    // Register all IPC handlers
    registerAllHandlers();

    // Start the SMTP outbox (persist-first send retry queue). sendEmailFromMain
    // and appendSentCopy are injected so the service never imports the SMTP
    // handlers back. appendSentCopy uploads the durable Sent-folder copy after
    // SMTP accepts a message (generic servers like sarv.com don't auto-file it).
    initOutbox({ sendFn: sendEmailFromMain, appendSentFn: appendSentCopy });

    // Create main window
    createWindow();

    // Power monitor: handle laptop sleep/wake transitions. When the OS
    // resumes from sleep, the network stack (Wi-Fi reattach + DHCP +
    // DNS) is typically still settling for 1-3 seconds. The renderer
    // already has its own settle/probe gate; this just signals it so
    // it can run a check at exactly the right moment (instead of
    // waiting for the next focus event).
    //
    // Symptoms without this:
    //   ENOTFOUND oauth2.googleapis.com
    //   "Max reconnect attempts reached"
    //   ...because the connection manager burned through its 5
    //   retries during the network-cold window after wake.
    try {
      powerMonitor.on('suspend', () => {
        logger.info('[Main] System suspending — closing IMAP connections + notifying renderer');
        // Suppress background reconnects until a REAL user wake. A macOS Power Nap
        // dark-wake fires no 'resume', so without this the backgroundSync timer
        // would open a fresh IMAP connection during the nap that immediately
        // freezes into a Gmail-cap zombie when the Mac drops back to sleep.
        setSystemSuspended(true);
        // Cancel any token refresh already on the wire. Sleep FREEZES an
        // in-flight request instead of failing it, so without this the POST
        // outlives the process's attention: a rotating provider can consume the
        // refresh token, we never see the response that carries its
        // replacement, and the next wake replays a spent token — which reads as
        // a stolen-token replay and revokes the entire session. Aborting cannot
        // un-send a request the server already got, but it ends the wait at a
        // moment we chose. `setSystemSuspended(true)` above is what stops new
        // refreshes from starting during a dark wake.
        abortInFlightTokenRefreshes('system suspend');
        sendToWindow('system:suspend');
        // Close every IMAP socket BEFORE the machine sleeps. Sleep otherwise
        // FREEZES live sockets (no FIN), and the server keeps counting them
        // against its per-account cap (Gmail = 15) for ~30 min — so on wake the
        // fresh connections tip over the cap ("Too many simultaneous
        // connections"). Best-effort + fire-and-forget: suspend gives us little
        // time and a hung socket must never delay sleep. Resume reconnects via
        // the renderer's network-gated ensureConnectionAndSync.
        void disconnectAllImapEngines().catch(() => { /* best-effort before sleep */ });
      });
      powerMonitor.on('resume', () => {
        // Sleep froze every IMAP socket; the connection POOLS still hold them and
        // would otherwise be discovered dead only lazily — one 60s FETCH timeout at
        // a time — while fresh connects stack on top, tripping Gmail's
        // simultaneous-connection cap ("Too many simultaneous connections") every
        // morning. Only the FOREGROUND account's forceReconnect rebuilds its pool;
        // BACKGROUND accounts (via backgroundSync) never reset theirs. So drop
        // EVERY account's stale connections up front, THEN let the renderer probe
        // the network and reconnect from a clean slate (background accounts rebuild
        // fresh on their next sync tick). Best-effort + fire-and-forget: a hung
        // frozen socket must not delay the reconnect.
        logger.info('[Main] System resumed from sleep — dropping stale IMAP connections (all accounts), then notifying renderer to reconnect');
        // Each disconnect is already self-bounded (~5s logout cap + force close),
        // but guard with a hard 6s ceiling so a pathological hang can never delay
        // the reconnect notification — teardown just continues in the background.
        let notified = false;
        const notifyOnce = (): void => {
          if (notified) return;
          notified = true;
          // Real user wake — re-enable background reconnects, then reconnect from
          // a clean slate.
          setSystemSuspended(false);
          sendToWindow('system:resume');
        };
        void disconnectAllImapEngines().catch(() => { /* best-effort */ }).finally(notifyOnce);
        setTimeout(notifyOnce, 6000);
      });
      powerMonitor.on('lock-screen', () => {
        sendToWindow('system:lock');
      });
      powerMonitor.on('unlock-screen', () => {
        logger.info('[Main] Screen unlocked — notifying renderer');
        // A genuine user wake even if 'resume' didn't fire (e.g. it was only a
        // display sleep) — lift the background-reconnect suppression.
        setSystemSuspended(false);
        sendToWindow('system:unlock');
      });
    } catch (err) {
      logger.warn('[Main] powerMonitor wiring failed:', err);
    }

    // Watch for main-thread blocks from here on. Started at the END of init but
    // BEFORE the first folder sync, which is when the beachball actually shows up.
    // Silent unless the loop genuinely stalls, so it costs one timer tick.
    stopEventLoopMonitor = startEventLoopMonitor({
      // A suspended machine cannot fire a timer, so the wall-clock gap across
      // sleep is not a freeze — it was reported as one, drowning the real
      // findings: one afternoon of Power Naps produced 21 "the UI was frozen"
      // warnings of which only 3 were real. `getSystemSuspended` is the flag the
      // powerMonitor handlers above already keep for that window.
      isSuspended: getSystemSuspended,
      onStall: (stallMs, cause) => {
        const message = describeStall(stallMs, cause);
        // Sleep gaps are expected and say nothing about app health, so they log
        // at info: still there for correlating a post-wake symptom, without
        // claiming a freeze that never happened.
        if (cause === 'sleep') logger.info(message);
        else logger.warn(message);
      },
    });

    logger.info('[Main] App initialization complete');
  } catch (error) {
    logger.error('[Main] Failed to initialize app:', error);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // In dev, closing the window fully quits the app so the vite dev server
  // (our parent process) exits too: quit -> before-quit teardown ->
  // app.exit() -> the Electron child process exits -> vite-plugin-electron's
  // `once('exit', process.exit)` tears down vite. Without this, macOS keeps
  // the app alive and the terminal server keeps running after you close the
  // window. Fully quitting is safe here (unlike the old partial teardown that
  // bricked reopened windows) because the whole process goes away.
  //
  // Packaged (non-dev) macOS keeps the standard keep-alive behavior so the
  // dock-icon 'activate' can recreate the window; all teardown lives in
  // before-quit.
  if (isDev || process.platform !== 'darwin') {
    app.quit();
  }
});

// Electron does NOT await async 'before-quit' listeners — without the
// preventDefault-once pattern below, the process exits before IMAP logout /
// SMTP disconnect / extension shutdown / storage.close() ever complete.
// True only when this quit was triggered by a terminating SIGNAL (vite hot-restart
// SIGTERM, Ctrl+C SIGINT, OS shutdown). Distinguishes those from a genuine in-app
// quit so the reverse teardown below never kills the launcher during a hot-restart.
let quitInitiatedBySignal = false;

// PROD: stops the liveness heartbeat timer and removes its file. Set once we hold
// the lock; called on teardown so a clean exit leaves no stale heartbeat behind.
let stopHeartbeatWriter: (() => void) | null = null;

// DEV: stops the pid-record timer and removes its file, so a cleanly-quit dev run
// leaves no pid for the next launch to chase.
let stopDevInstanceRecord: (() => void) | null = null;

let teardownDone = false;
app.on('before-quit', (event) => {
  if (teardownDone) return;
  event.preventDefault();

  // Reverse teardown: closing the app (Cmd+Q / window close) should also bring
  // down the terminal's `pnpm dev:desktop`, mirroring how Ctrl+C closes the app.
  // Skipped on a signal-driven quit (vite hot-restart) so an edit doesn't kill the
  // dev server. Best-effort: SIGTERM the launcher we recorded at module load; if
  // it's already gone (we were orphaned) the throw is harmless.
  if (shouldKillLauncherOnQuit({ isDev, quitBySignal: quitInitiatedBySignal })) {
    try {
      process.kill(DEV_LAUNCHER_PID, 'SIGTERM');
      logger.info(`[Shutdown] in-app quit — signalled dev launcher pid=${DEV_LAUNCHER_PID} to close the terminal session.`);
    } catch {
      // Launcher already exited (or not signalable) — nothing to close.
    }
  }

  // Stop the prod liveness heartbeat and remove its file up front, so a clean quit
  // never leaves a fresh-looking heartbeat the next launch could misread. Synchronous
  // and safe to run before the async teardown below.
  try {
    stopHeartbeatWriter?.();
    stopHeartbeatWriter = null;
    stopDevInstanceRecord?.();
    stopDevInstanceRecord = null;
  } catch {
    // Best-effort.
  }

  // Teardown itself is synchronous in places; a stall warning fired while quitting
  // is noise, not a finding.
  try {
    stopEventLoopMonitor?.();
    stopEventLoopMonitor = null;
  } catch {
    // Best-effort.
  }

  // Hard force-exit backstop, independent of the teardown promise below. The
  // teardown no longer performs a synchronous DB close, so the event loop stays
  // responsive and this timer reliably fires even if an async disconnect hangs.
  setTimeout(() => {
    logger.warn('[Shutdown] force-exit watchdog fired — hard exit');
    process.exit(0);
  }, 3500);

  const teardown = async () => {
    setIsQuitting(true);
    // Stop spraying shutdown logs onto the terminal — the shell prompt has already
    // returned (pnpm/vite exited), so further output just buries it. app.log still
    // captures everything below.
    muteTerminalOutput();
    stopBackgroundTimers();
    // Let the pipeline-event persister's final flush reach the DB before we
    // start closing things underneath it.
    await awaitBackgroundTimerShutdown();

    // Graceful IMAP shutdown: disconnect EVERY account's engine (active +
    // background) so no pool/IDLE socket leaks across a restart and piles up
    // against the server's per-account connection cap. See disconnectAllImapEngines.
    await disconnectAllImapEngines();

    const smtpClient = getSmtpClient();
    if (smtpClient) {
      try {
        await smtpClient.disconnect();
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Stop feeding the runner BEFORE shutting the manager down, so a message
    // still draining cannot call into an extension that is being deactivated.
    stopExtensionWorkflowRunner();

    const extensionManager = getExtensionManager();
    if (extensionManager) {
      try {
        await extensionManager.shutdown();
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Stop the outbox drain timer before tearing down storage.
    stopOutbox();

    // NOTE: storage.close() is deliberately NOT called on the exit path.
    // better-sqlite3's db.close() is SYNCHRONOUS and, on a large WAL database,
    // blocks the event loop long enough to freeze EVERY timer — including the
    // force-exit watchdog and the race timeout below — which is exactly the
    // "Ctrl+C hangs forever" bug. WAL is crash-safe: the DB is recovered and
    // checkpointed on the next open, so skipping a clean close on shutdown is
    // safe. A guaranteed fast exit matters more than a tidy close.
  };

  // Bound the teardown so a hung IMAP logout can never make the app
  // un-quittable; then exit for real. process.exit is more forceful than
  // app.exit (which can be swallowed mid-quit). Now that no synchronous DB close
  // freezes the loop, this timer reliably fires.
  void Promise.race([
    teardown().catch(() => { /* never block quit */ }),
    new Promise<void>((resolve) => setTimeout(resolve, 3000)),
  ]).finally(() => {
    teardownDone = true;
    process.exit(0);
  });
});

// A SIGNAL (dev hot-restart, OS shutdown, `kill`) terminates the main process
// WITHOUT firing 'before-quit', so IMAP sockets (IDLE + pool) would close only
// via an abrupt OS RST — which servers don't always free promptly (an IDLE
// connection can be held to its ~29-min timeout), letting sockets pile up against
// Gmail's 15-connections/account cap across restarts. Route the CATCHABLE signals
// through the normal quit so the graceful teardown (clean LOGOUT of every engine,
// close pools + IDLE, close storage) runs first. SIGKILL is uncatchable — nothing
// can help there. `once` so a repeated signal can't re-enter (before-quit is also
// guarded by teardownDone).
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(sig, () => {
    logger.info(`[Shutdown] ${sig} received — graceful quit`);
    // Mark this as signal-driven so before-quit does NOT kill the launcher: a vite
    // hot-restart arrives as SIGTERM and must be free to respawn us, and on Ctrl+C
    // the launcher is already dying — no need to signal it back.
    quitInitiatedBySignal = true;
    try { app.quit(); } catch { app.exit(); }
  });
}
