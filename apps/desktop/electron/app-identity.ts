import { app } from 'electron';

import { isDevBuild } from './utils/dev-mode';

/**
 * The app's identity, set before ANY other main-process module loads.
 *
 * `app.name` decides the userData folder ("Sarv Inbox Dev" vs "Sarv Inbox"),
 * the macOS menu name and the safeStorage keychain item. Electron fixes the
 * userData path the first time anything reads it, so a module that touches
 * the data folder, the core database or the keychain while it loads would,
 * if it ran before this, tie a dev run to the INSTALLED app's data and key.
 * That happened on 2026-11-19 (a service that read the core database in its
 * constructor). main.ts imports this file first, so the name is in place
 * before any other import's top level runs.
 */
export const isDev = isDevBuild();
export const APP_NAME = isDev ? 'Sarv Inbox Dev' : 'Sarv Inbox';
app.name = APP_NAME;
