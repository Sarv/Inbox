import { resolve, join } from 'node:path';

import { app, dialog, type BrowserWindow } from 'electron';

import { assertNoProfileReset, eraseProfile, getResetProfiles } from '../../../../scripts/lib/profile-reset.mjs';
import type { LocalDataEraseRequest, LocalDataProfileId, LocalDataProfiles } from '../../src/types/local-data';

import { consumeLocalDataResetTicket, createLocalDataResetTicket, LOCAL_DATA_RESET_ENV } from './local-data-reset-ticket';

let erasing = false;
let restarting = false;

const labels = { production: 'Sarv Inbox', development: 'Sarv Inbox Dev' } as const;

function identity(requireStandard = true): { profile: LocalDataProfileId; baseDir: string; directory: string; standard: boolean } {
  const name = app.getName();
  const profile = name === labels.production ? 'production' : name === labels.development ? 'development' : null;
  if (!profile) throw new Error('This application profile cannot be reset.');
  const baseDir = app.getPath('appData');
  const directory = join(baseDir, labels[profile]);
  const comparable = (value: string) => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  const standard = comparable(app.getPath('userData')) === comparable(directory);
  if (requireStandard && !standard) {
    throw new Error('A custom data directory is in use. Reset is available only for the standard production and development profiles.');
  }
  return { profile, baseDir, directory, standard };
}

/** Metadata only. Renderer callers can select an enum, never a filesystem path. */
export function getLocalDataProfiles(): LocalDataProfiles {
  const current = identity();
  return {
    currentProfile: current.profile,
    profiles: getResetProfiles({ baseDir: current.baseDir, ignorePid: process.pid }).map(profile => ({
      id: profile.id,
      label: `${profile.label} (${profile.id})`,
      current: profile.id === current.profile,
      exists: profile.exists,
      running: profile.id === current.profile || profile.running,
      path: profile.dir,
      ...(profile.blockedReason ? { blockedReason: profile.blockedReason } : {}),
    })),
  };
}

function validateRequest(value: unknown): LocalDataEraseRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a profile and confirm the reset.');
  const request = value as Partial<LocalDataEraseRequest>;
  if ((request.profile !== 'production' && request.profile !== 'development')
    || request.confirmation !== `ERASE ${request.profile}`
    || Object.keys(value).some(key => key !== 'profile' && key !== 'confirmation')) {
    throw new Error('Type the exact confirmation for the selected production or development profile.');
  }
  return request as LocalDataEraseRequest;
}

/** Native confirmation is independent of the renderer's typed confirmation. */
export async function eraseLocalData(value: unknown, parent: BrowserWindow): Promise<{ restarting: boolean; requiresManualStart?: boolean }> {
  const request = validateRequest(value);
  if (erasing || restarting) throw new Error('A local data reset is already in progress.');
  erasing = true;
  try {
    const current = identity();
    const selected = getResetProfiles({ baseDir: current.baseDir, ignorePid: process.pid }).find(profile => profile.id === request.profile);
    if (!selected) throw new Error('The selected profile is unavailable.');
    if (selected.running || selected.blockedReason) throw new Error(selected.blockedReason || `Quit ${selected.label} before erasing its local data.`);
    if (!selected.exists) throw new Error('The selected profile has no local data to erase.');
    const isCurrent = current.profile === request.profile;
    const developmentQuit = isCurrent && request.profile === 'development';
    const answer = await dialog.showMessageBox(parent, {
      type: 'warning',
      title: 'Erase all local data',
      message: `Erase all local data for ${selected.label} (${request.profile})?`,
      detail: 'This permanently removes local mail, attachments, accounts, saved passwords and tokens, drafts, Outbox messages, assistant chats, contacts, local calendars and settings. Local-only items cannot be recovered.\n\n'
        + 'Mail on your email servers and the other Inbox profile are not changed. Your browser sign-ins and the OS Keychain encryption master remain; neither restores the deleted Inbox account tokens.\n\n'
        + (developmentQuit ? 'Inbox will quit to finish the reset. Restart your development server afterward.' : isCurrent ? 'Inbox will restart to finish the reset and show onboarding.' : 'The selected profile must remain closed until the reset finishes.'),
      buttons: ['Cancel', developmentQuit ? 'Erase and quit' : isCurrent ? 'Erase and restart' : 'Erase local data'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) throw new Error('Reset cancelled. No local data was erased.');
    if (parent.isDestroyed()) throw new Error('The confirmation window closed. No local data was erased.');
    if (!isCurrent) {
      // Rechecks paths, liveness and the operation lock after the user confirms.
      eraseProfile({ profile: request.profile, baseDir: current.baseDir, ignorePid: process.pid });
      return { restarting: false };
    }
    const ticket = createLocalDataResetTicket(current.directory, current.profile);
    const previous = process.env[LOCAL_DATA_RESET_ENV];
    const previousKeychain = process.env.SARVINBOX_KEYCHAIN_RELAUNCH;
    process.env[LOCAL_DATA_RESET_ENV] = ticket.token;
    delete process.env.SARVINBOX_KEYCHAIN_RELAUNCH;
    try {
      // Do not replay old mailto URLs, calendar files or open-request arguments
      // into a freshly erased profile. Dev retains only its compiled entrypoint.
      // The renamed development Electron can report isPackaged=true while it
      // still needs '.'/the main entry. The configured profile is authoritative.
      const args = current.profile === 'development' ? process.argv.slice(1, 2) : [];
      if ((app.relaunch as (options: { args: string[] }) => unknown)({ args }) === false) throw new Error('Relaunch was declined');
    } catch {
      ticket.cleanup();
      if (previous === undefined) delete process.env[LOCAL_DATA_RESET_ENV]; else process.env[LOCAL_DATA_RESET_ENV] = previous;
      if (previousKeychain === undefined) delete process.env.SARVINBOX_KEYCHAIN_RELAUNCH; else process.env.SARVINBOX_KEYCHAIN_RELAUNCH = previousKeychain;
      throw new Error('Inbox could not schedule the reset. No local data was erased.');
    }
    restarting = true;
    setTimeout(() => app.quit(), 150);
    return { restarting: true, ...(developmentQuit ? { requiresManualStart: true } : {}) };
  } finally {
    erasing = false;
  }
}

/** Called at module startup after app identity, before Sentry/logging/DB/session I/O. */
export function initializeLocalDataReset(): { erased: boolean } {
  const token = process.env[LOCAL_DATA_RESET_ENV];
  delete process.env[LOCAL_DATA_RESET_ENV];
  const current = identity(token !== undefined);
  if (token !== undefined) {
    delete process.env.SARVINBOX_KEYCHAIN_RELAUNCH;
    consumeLocalDataResetTicket(current.directory, token, current.profile);
    eraseProfile({ profile: current.profile, baseDir: current.baseDir, ignorePid: process.pid });
    return { erased: true };
  }
  if (current.standard) assertNoProfileReset({ profile: current.profile, baseDir: current.baseDir });
  return { erased: false };
}

export function isLocalDataResetRestarting(): boolean { return restarting; }
