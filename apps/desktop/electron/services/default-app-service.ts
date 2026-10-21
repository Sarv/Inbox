import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { app, shell } from 'electron';

import type { DefaultAppRequestResult, DefaultAppsState, DefaultAppTarget, DefaultAppTargetStatus } from '../../src/types/default-apps';

import { getCoreDb, readAppSetting } from './core-db';

export const DEFAULT_APPS_PROMPT_SETTING = 'default-apps.suppress-prompt';
export const DEFAULT_APPS_DESKTOP_ID = 'com.sarv.sarvinbox.desktop';
export const DEFAULT_APPS_ICS_PROG_ID = 'com.sarv.sarvinbox.ics';
const BUNDLE_ID = 'com.sarv.sarvinbox';

// Fixed scripts only: no renderer input or file paths are interpolated into native code.
export const MAC_CALENDAR_QUERY = "ObjC.import('CoreServices'); ObjC.unwrap(ObjC.castRefToObject($.LSCopyDefaultRoleHandlerForContentType($('com.apple.ical.ics'), 0xffffffff))) || ''";
export const MAC_CALENDAR_SET = `ObjC.import('CoreServices'); $.LSSetDefaultRoleHandlerForContentType($('com.apple.ical.ics'), 0xffffffff, $('${BUNDLE_ID}'))`;

export interface DefaultAppServiceDeps {
  platform: string;
  packaged: boolean;
  isDefaultMail: () => boolean;
  setDefaultMail: () => boolean;
  isDefaultCalendarLink: (scheme: 'webcal' | 'webcals') => boolean;
  setDefaultCalendarLink: (scheme: 'webcal' | 'webcals') => boolean;
  run: (file: string, args: string[]) => Promise<string>;
  openExternal: (url: string) => Promise<void>;
  linuxDesktopInstalled: () => Promise<boolean>;
  readSuppressed: () => boolean;
  writeSuppressed: (suppressed: boolean) => void;
}

export function runDefaultAppCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, maxBuffer: 16_384, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error('The operating system could not check or update the default application.'));
      else resolve(stdout.trim());
    });
  });
}

async function linuxDesktopInstalled(): Promise<boolean> {
  const dataHome = process.env.XDG_DATA_HOME;
  const directories = [dataHome || join(homedir(), '.local/share'), '/usr/local/share', '/usr/share'];
  for (const directory of directories) {
    try { await access(join(directory, 'applications', DEFAULT_APPS_DESKTOP_ID)); return true; } catch { /* Try the next standard desktop location. */ }
  }
  return false;
}

function defaultDeps(): DefaultAppServiceDeps {
  return {
    platform: process.platform,
    packaged: app.isPackaged,
    isDefaultMail: () => app.isDefaultProtocolClient('mailto'),
    setDefaultMail: () => app.setAsDefaultProtocolClient('mailto'),
    isDefaultCalendarLink: scheme => app.isDefaultProtocolClient(scheme),
    setDefaultCalendarLink: scheme => app.setAsDefaultProtocolClient(scheme),
    run: runDefaultAppCommand,
    openExternal: url => shell.openExternal(url),
    linuxDesktopInstalled,
    readSuppressed: () => readAppSetting(DEFAULT_APPS_PROMPT_SETTING) === 'true',
    writeSuppressed: suppressed => {
      // A durable preference is acknowledged only after the write succeeds.
      getCoreDb().prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(DEFAULT_APPS_PROMPT_SETTING, String(suppressed), Date.now());
    },
  };
}

export class DefaultAppService {
  constructor(private readonly deps: DefaultAppServiceDeps) {}

  async getStatus(): Promise<DefaultAppsState> {
    const suppressPrompt = this.deps.readSuppressed();
    const [email, calendar] = await Promise.all([this.targetStatus('email'), this.targetStatus('calendar')]);
    return {
      platform: this.deps.platform,
      packaged: this.deps.packaged,
      suppressPrompt,
      shouldPrompt: this.deps.packaged && !suppressPrompt && [email, calendar].some(target => target.canRequest && target.status !== 'default'),
      email, calendar,
    };
  }

  async setPromptSuppressed(suppressed: unknown): Promise<DefaultAppsState> {
    if (typeof suppressed !== 'boolean') throw new Error('Choose whether to show the default app prompt.');
    this.deps.writeSuppressed(suppressed);
    return this.getStatus();
  }

  async requestDefault(target: unknown): Promise<DefaultAppRequestResult> {
    const validTarget = this.target(target);
    const before = await this.getStatus();
    if (before[validTarget].status === 'default') return { state: before, outcome: 'default', message: this.defaultMessage(validTarget) };
    if (!before[validTarget].canRequest) return { state: before, outcome: 'unsupported', message: before[validTarget].detail || 'This platform does not support changing this default here.' };

    if (this.deps.platform === 'win32') {
      await this.openSettings(validTarget);
      return { state: await this.getStatus(), outcome: 'settings-opened', message: `Choose Sarv Inbox in Windows Default apps for ${validTarget === 'email' ? 'MAILTO links' : '.ics calendar files and WEBCAL/WEBCALS links'}.` };
    }
    if (this.deps.platform === 'darwin') {
      if (validTarget === 'email') this.deps.setDefaultMail();
      else {
        const code = await this.deps.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_CALENDAR_SET]);
        if (code !== '0') throw new Error('macOS did not accept the calendar application change. You can choose Sarv Inbox using an .ics file’s Get Info window.');
        this.deps.setDefaultCalendarLink('webcal');
        this.deps.setDefaultCalendarLink('webcals');
      }
    } else if (this.deps.platform === 'linux') {
      // Recheck registration at the point of mutation; an unintegrated AppImage must not become a broken default.
      if (!await this.deps.linuxDesktopInstalled()) throw new Error('Install Sarv Inbox’s desktop integration before choosing it as a default application.');
      const mimeTypes = validTarget === 'email' ? ['x-scheme-handler/mailto'] : ['text/calendar', 'x-scheme-handler/webcal', 'x-scheme-handler/webcals'];
      for (const mimeType of mimeTypes) await this.deps.run('xdg-mime', ['default', DEFAULT_APPS_DESKTOP_ID, mimeType]);
    }
    const state = await this.getStatus();
    return state[validTarget].status === 'default'
      ? { state, outcome: 'default', message: this.defaultMessage(validTarget) }
      : { state, outcome: 'requested', message: `The operating system has not confirmed Sarv Inbox as your default ${validTarget} app. You may need to confirm its application chooser.` };
  }

  async openSettings(target?: unknown): Promise<{ opened: boolean }> {
    if (target !== undefined) this.target(target);
    if (!this.deps.packaged) return { opened: false };
    const url = this.deps.platform === 'win32' ? 'ms-settings:defaultapps'
      : this.deps.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.preference.general' : null;
    if (!url) return { opened: false };
    await this.deps.openExternal(url);
    return { opened: true };
  }

  private target(value: unknown): DefaultAppTarget {
    if (value !== 'email' && value !== 'calendar') throw new Error('Choose email or calendar as the default application.');
    return value;
  }

  private defaultMessage(target: DefaultAppTarget): string {
    return target === 'email' ? 'Sarv Inbox is the default app for email links.' : 'Sarv Inbox is the default app for .ics files and calendar links.';
  }

  private async targetStatus(target: DefaultAppTarget): Promise<DefaultAppTargetStatus> {
    if (!this.deps.packaged) return { status: 'unsupported', canRequest: false, method: 'none', detail: 'Install the packaged Sarv Inbox app to set default applications.' };
    const platform = this.deps.platform;
    if (!['darwin', 'win32', 'linux'].includes(platform)) return { status: 'unsupported', canRequest: false, method: 'none', detail: 'Default application integration is unavailable on this platform.' };
    const method = platform === 'win32' ? 'settings' : target === 'email' ? 'protocol' : 'file-association';
    let canRequest = true;
    try {
      let selected = '';
      if (platform === 'linux') {
        canRequest = await this.deps.linuxDesktopInstalled();
        selected = await this.deps.run('xdg-mime', ['query', 'default', target === 'email' ? 'x-scheme-handler/mailto' : 'text/calendar']);
        const linksDefault = target === 'email' || (await Promise.all(['webcal', 'webcals'].map(scheme => this.deps.run('xdg-mime', ['query', 'default', `x-scheme-handler/${scheme}`])))).every(value => value === DEFAULT_APPS_DESKTOP_ID);
        return { status: selected === DEFAULT_APPS_DESKTOP_ID && linksDefault ? 'default' : 'not-default', canRequest, method,
          ...(!canRequest ? { detail: 'Install Sarv Inbox’s desktop integration to make it a default app.' }
            : target === 'calendar' && selected === DEFAULT_APPS_DESKTOP_ID && !linksDefault ? { detail: 'Calendar files already open in Sarv Inbox. Some calendar links still open in another app.' } : {}) };
      }
      if (target === 'email') return { status: this.deps.isDefaultMail() ? 'default' : 'not-default', canRequest, method };
      if (platform === 'darwin') {
        selected = await this.deps.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_CALENDAR_QUERY]);
        return this.calendarStatus(selected ? selected === BUNDLE_ID : null, canRequest, method);
      }
      const result = await this.deps.run('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.ics\\UserChoice', '/v', 'ProgId']);
      selected = /^\s*ProgId\s+REG_SZ\s+(\S+)\s*$/im.exec(result)?.[1] || '';
      return this.calendarStatus(selected ? selected.toLowerCase() === DEFAULT_APPS_ICS_PROG_ID : null, canRequest, method);
    } catch {
      return { status: 'unknown', canRequest, method, detail: `The operating system could not confirm the default ${target} app.` };
    }
  }

  private calendarStatus(filesDefault: boolean | null, canRequest: boolean, method: DefaultAppTargetStatus['method']): DefaultAppTargetStatus {
    const linksDefault = this.deps.isDefaultCalendarLink('webcal') && this.deps.isDefaultCalendarLink('webcals');
    return { status: filesDefault === null ? 'unknown' : filesDefault && linksDefault ? 'default' : 'not-default', canRequest, method,
      ...(filesDefault === null ? { detail: 'The current .ics file choice could not be confirmed. Calendar defaults include .ics files and WEBCAL/WEBCALS links.' }
        : filesDefault && !linksDefault ? { detail: 'Calendar files already open in Sarv Inbox. Some calendar links still open in another app.' }
          : !filesDefault && linksDefault ? { detail: 'Calendar links already open in Sarv Inbox. Calendar files still open in another app.' } : {}) };
  }
}

let service: DefaultAppService | undefined;
export function getDefaultAppService(): DefaultAppService {
  return service ??= new DefaultAppService(defaultDeps());
}
