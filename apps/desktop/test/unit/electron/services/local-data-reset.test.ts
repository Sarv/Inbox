import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  name: vi.fn(), getPath: vi.fn(), app: { isPackaged: true, relaunch: vi.fn(), quit: vi.fn() },
  confirm: vi.fn(), profiles: vi.fn(), erase: vi.fn(), assertUnlocked: vi.fn(),
  createTicket: vi.fn(), consumeTicket: vi.fn(), cleanup: vi.fn(),
  parent: { isDestroyed: vi.fn() },
}));
vi.mock('electron', () => ({ app: { getName: h.name, getPath: h.getPath, get isPackaged() { return h.app.isPackaged; }, relaunch: h.app.relaunch, quit: h.app.quit }, dialog: { showMessageBox: h.confirm } }));
vi.mock('../../../../../../scripts/lib/profile-reset.mjs', () => ({ getResetProfiles: h.profiles, eraseProfile: h.erase, assertNoProfileReset: h.assertUnlocked }));
vi.mock('../../../../electron/services/local-data-reset-ticket', () => ({
  LOCAL_DATA_RESET_ENV: 'SARVINBOX_LOCAL_DATA_RESET', createLocalDataResetTicket: h.createTicket, consumeLocalDataResetTicket: h.consumeTicket,
}));

const base = join(tmpdir(), 'inbox-reset-service-tests');
const rows = () => [
  { id: 'production', label: 'Sarv Inbox', dir: join(base, 'Sarv Inbox'), exists: true, running: false },
  { id: 'development', label: 'Sarv Inbox Dev', dir: join(base, 'Sarv Inbox Dev'), exists: true, running: false },
];
let service: typeof import('../../../../electron/services/local-data-reset');
const parent = () => h.parent as unknown as Parameters<typeof service.eraseLocalData>[1];
const request = (profile: 'production' | 'development' = 'production') => ({ profile, confirmation: `ERASE ${profile}` });

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers();
  vi.stubEnv('SARVINBOX_LOCAL_DATA_RESET', undefined); vi.stubEnv('SARVINBOX_KEYCHAIN_RELAUNCH', undefined);
  h.name.mockReturnValue('Sarv Inbox');
  h.getPath.mockImplementation(name => name === 'appData' ? base : join(base, h.name()));
  h.app.isPackaged = true;
  h.profiles.mockImplementation(rows); h.confirm.mockResolvedValue({ response: 1 });
  h.createTicket.mockReturnValue({ token: 'one-use-token', cleanup: h.cleanup });
  h.parent.isDestroyed.mockReturnValue(false);
  service = await import('../../../../electron/services/local-data-reset');
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('confirmed local data erasure', () => {
  it('lists metadata and marks the current profile without reading credentials', () => {
    expect(service.getLocalDataProfiles()).toMatchObject({ currentProfile: 'production', profiles: [
      { id: 'production', current: true, running: true, path: join(base, 'Sarv Inbox') },
      { id: 'development', current: false, running: false },
    ] });
    expect(h.profiles).toHaveBeenCalledWith({ baseDir: base, ignorePid: process.pid });
    expect(h.erase).not.toHaveBeenCalled(); expect(h.createTicket).not.toHaveBeenCalled();
  });
  it.each([null, {}, { profile: 'all', confirmation: 'ERASE all' }, { profile: 'production', confirmation: 'erase production' }, { ...request(), path: '/arbitrary' }])('rejects invalid confirmation/paths before a native prompt: %j', async value => {
    await expect(service.eraseLocalData(value, parent())).rejects.toThrow();
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.erase).not.toHaveBeenCalled(); expect(h.createTicket).not.toHaveBeenCalled();
  });
  it('defaults the OS confirmation to Cancel and cancellation performs no mutation', async () => {
    h.confirm.mockResolvedValue({ response: 0 });
    await expect(service.eraseLocalData(request(), parent())).rejects.toThrow(/cancelled/);
    expect(h.confirm.mock.calls[0][1]).toMatchObject({ defaultId: 0, cancelId: 0, buttons: ['Cancel', 'Erase and restart'] });
    expect(h.erase).not.toHaveBeenCalled(); expect(h.app.relaunch).not.toHaveBeenCalled(); expect(h.createTicket).not.toHaveBeenCalled();
  });
  it('prevents simultaneous prompts and duplicate deletion', async () => {
    let finish!: (value: { response: number }) => void;
    h.confirm.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = service.eraseLocalData(request('development'), parent());
    await expect(service.eraseLocalData(request(), parent())).rejects.toThrow(/already in progress/);
    finish({ response: 1 }); await pending;
    expect(h.erase).toHaveBeenCalledOnce(); expect(h.confirm).toHaveBeenCalledOnce();
  });
  it('erases only a closed other profile and never restarts or touches the current profile', async () => {
    expect(await service.eraseLocalData(request('development'), parent())).toEqual({ restarting: false });
    expect(h.erase).toHaveBeenCalledExactlyOnceWith({ profile: 'development', baseDir: base, ignorePid: process.pid });
    expect(h.app.relaunch).not.toHaveBeenCalled(); expect(h.createTicket).not.toHaveBeenCalled();
  });
  it('refuses running or unsafe other profiles', async () => {
    h.profiles.mockReturnValue(rows().map(row => row.id === 'development' ? { ...row, running: true, blockedReason: 'Quit Sarv Inbox Dev first.' } : row));
    await expect(service.eraseLocalData(request('development'), parent())).rejects.toThrow(/Quit/);
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.erase).not.toHaveBeenCalled();
  });
  it('schedules current-profile reset without erasing open databases and strips external launch arguments', async () => {
    vi.stubEnv('SARVINBOX_KEYCHAIN_RELAUNCH', 'old-open-request');
    expect(await service.eraseLocalData(request(), parent())).toEqual({ restarting: true });
    expect(h.erase).not.toHaveBeenCalled();
    expect(h.createTicket).toHaveBeenCalledWith(join(base, 'Sarv Inbox'), 'production');
    expect(process.env.SARVINBOX_LOCAL_DATA_RESET).toBe('one-use-token');
    expect(process.env.SARVINBOX_KEYCHAIN_RELAUNCH).toBeUndefined();
    expect(h.app.relaunch).toHaveBeenCalledWith({ args: [] });
    expect(service.isLocalDataResetRestarting()).toBe(true); expect(h.app.quit).not.toHaveBeenCalled();
    await vi.runAllTimersAsync(); expect(h.app.quit).toHaveBeenCalledOnce();
    await expect(service.eraseLocalData(request(), parent())).rejects.toThrow(/already in progress/);
  });
  it('development reset truthfully requires a manual server restart', async () => {
    // The renamed development app reports isPackaged=true on this Mac, but
    // Electron still needs the entrypoint to run the reset bootstrap.
    h.name.mockReturnValue('Sarv Inbox Dev'); h.app.isPackaged = true;
    expect(await service.eraseLocalData(request('development'), parent())).toEqual({ restarting: true, requiresManualStart: true });
    expect(h.confirm.mock.calls[0][1].buttons).toEqual(['Cancel', 'Erase and quit']);
    expect(h.app.relaunch).toHaveBeenCalledWith({ args: process.argv.slice(1, 2) });
    expect(h.erase).not.toHaveBeenCalled();
  });
  it.each([false, 'throw'])('does not erase or quit if a relaunch fails (%s)', async failure => {
    vi.stubEnv('SARVINBOX_KEYCHAIN_RELAUNCH', 'preserve-old-request');
    if (failure === 'throw') h.app.relaunch.mockImplementation(() => { throw new Error('failed'); });
    else h.app.relaunch.mockReturnValue(false);
    await expect(service.eraseLocalData(request(), parent())).rejects.toThrow(/No local data was erased/);
    expect(h.cleanup).toHaveBeenCalledOnce(); expect(h.erase).not.toHaveBeenCalled(); expect(h.app.quit).not.toHaveBeenCalled();
    expect(process.env.SARVINBOX_LOCAL_DATA_RESET).toBeUndefined();
    expect(process.env.SARVINBOX_KEYCHAIN_RELAUNCH).toBe('preserve-old-request');
    expect(service.isLocalDataResetRestarting()).toBe(false);
  });
  it('surfaces failed removal instead of reporting success or restarting', async () => {
    h.erase.mockImplementation(() => { throw new Error('Reset incomplete'); });
    await expect(service.eraseLocalData(request('development'), parent())).rejects.toThrow(/incomplete/);
    expect(h.app.relaunch).not.toHaveBeenCalled();
  });
});

describe('pre-storage startup reset boundary', () => {
  it('a normal reinstall/launch only checks the lock and keeps data and login', () => {
    expect(service.initializeLocalDataReset()).toEqual({ erased: false });
    expect(h.assertUnlocked).toHaveBeenCalledWith({ profile: 'production', baseDir: base });
    expect(h.erase).not.toHaveBeenCalled(); expect(h.consumeTicket).not.toHaveBeenCalled();
  });
  it('normal custom user-data launches still work while reset refuses arbitrary directories', () => {
    h.getPath.mockImplementation(name => name === 'appData' ? base : join(base, 'custom-profile'));
    expect(service.initializeLocalDataReset()).toEqual({ erased: false });
    expect(h.assertUnlocked).not.toHaveBeenCalled();
    expect(() => service.getLocalDataProfiles()).toThrow(/custom data directory/);
  });
  it('validates and consumes a one-use ticket before erasing only the current build', () => {
    vi.stubEnv('SARVINBOX_LOCAL_DATA_RESET', 'one-use-token'); vi.stubEnv('SARVINBOX_KEYCHAIN_RELAUNCH', 'old');
    expect(service.initializeLocalDataReset()).toEqual({ erased: true });
    expect(h.consumeTicket).toHaveBeenCalledWith(join(base, 'Sarv Inbox'), 'one-use-token', 'production');
    expect(h.consumeTicket.mock.invocationCallOrder[0]).toBeLessThan(h.erase.mock.invocationCallOrder[0]);
    expect(h.erase).toHaveBeenCalledExactlyOnceWith({ profile: 'production', baseDir: base, ignorePid: process.pid });
    expect(process.env.SARVINBOX_LOCAL_DATA_RESET).toBeUndefined(); expect(process.env.SARVINBOX_KEYCHAIN_RELAUNCH).toBeUndefined();
  });
  it('refuses invalid tickets and clears the environment capability without deleting anything', () => {
    vi.stubEnv('SARVINBOX_LOCAL_DATA_RESET', 'forged'); h.consumeTicket.mockImplementation(() => { throw new Error('Invalid ticket'); });
    expect(() => service.initializeLocalDataReset()).toThrow(/Invalid ticket/);
    expect(process.env.SARVINBOX_LOCAL_DATA_RESET).toBeUndefined(); expect(h.erase).not.toHaveBeenCalled();
  });
  it('stops startup while another erase is in progress', () => {
    h.assertUnlocked.mockImplementation(() => { throw new Error('Reset in progress'); });
    expect(() => service.initializeLocalDataReset()).toThrow(/in progress/);
    expect(h.erase).not.toHaveBeenCalled();
  });
});
