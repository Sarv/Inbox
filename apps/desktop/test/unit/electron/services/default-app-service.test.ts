import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, shell: {} }));
vi.mock('../../../../electron/services/core-db', () => ({ getCoreDb: vi.fn(), readAppSetting: vi.fn() }));

import { DefaultAppService, DEFAULT_APPS_DESKTOP_ID, DEFAULT_APPS_ICS_PROG_ID, MAC_CALENDAR_QUERY, MAC_CALENDAR_SET, type DefaultAppServiceDeps } from '../../../../electron/services/default-app-service';

let deps: DefaultAppServiceDeps;
let suppressed: boolean;
beforeEach(() => {
  suppressed = false;
  deps = {
    platform: 'darwin', packaged: true,
    isDefaultMail: vi.fn().mockReturnValue(false), setDefaultMail: vi.fn().mockReturnValue(true),
    isDefaultCalendarLink: vi.fn().mockReturnValue(true), setDefaultCalendarLink: vi.fn().mockReturnValue(true),
    run: vi.fn().mockResolvedValue('com.apple.ical'), openExternal: vi.fn().mockResolvedValue(undefined),
    linuxDesktopInstalled: vi.fn().mockResolvedValue(true), readSuppressed: () => suppressed,
    writeSuppressed: vi.fn(value => { suppressed = value; }),
  };
});

describe('default application status and consent', () => {
  it('reads real email and .ics choices without changing any OS defaults', async () => {
    const state = await new DefaultAppService(deps).getStatus();
    expect(state).toMatchObject({ shouldPrompt: true, suppressPrompt: false, email: { status: 'not-default', method: 'protocol' }, calendar: { status: 'not-default', method: 'file-association' } });
    expect(deps.run).toHaveBeenCalledExactlyOnceWith('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_CALENDAR_QUERY]);
    expect(deps.setDefaultMail).not.toHaveBeenCalled(); expect(deps.openExternal).not.toHaveBeenCalled(); expect(deps.writeSuppressed).not.toHaveBeenCalled();
    expect(deps.setDefaultCalendarLink).not.toHaveBeenCalled();
  });

  it('does not query or request native defaults in a development build', async () => {
    deps.packaged = false;
    const service = new DefaultAppService(deps);
    expect(await service.getStatus()).toMatchObject({ shouldPrompt: false, packaged: false, email: { canRequest: false }, calendar: { canRequest: false } });
    expect((await service.requestDefault('calendar')).outcome).toBe('unsupported');
    expect(await service.openSettings()).toEqual({ opened: false });
    expect(deps.run).not.toHaveBeenCalled(); expect(deps.setDefaultMail).not.toHaveBeenCalled(); expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it('suppresses prompts only after an explicit durable preference write, and can re-enable them', async () => {
    const service = new DefaultAppService(deps);
    expect(await service.setPromptSuppressed(true)).toMatchObject({ shouldPrompt: false, suppressPrompt: true });
    expect(await service.setPromptSuppressed(false)).toMatchObject({ shouldPrompt: true, suppressPrompt: false });
    expect(deps.writeSuppressed).toHaveBeenNthCalledWith(1, true);
    expect(deps.writeSuppressed).toHaveBeenNthCalledWith(2, false);
    expect(deps.setDefaultMail).not.toHaveBeenCalled();
  });

  it('does not pretend an unreadable or unwritable preference was saved', async () => {
    deps.readSuppressed = () => { throw new Error('Store locked'); };
    await expect(new DefaultAppService(deps).getStatus()).rejects.toThrow('Store locked');
    deps.readSuppressed = () => false;
    deps.writeSuppressed = () => { throw new Error('Write failed'); };
    await expect(new DefaultAppService(deps).setPromptSuppressed(true)).rejects.toThrow('Write failed');
  });

  it.each([null, {}, 1, 'true', undefined])('rejects nonboolean suppression %j', async value => {
    await expect(new DefaultAppService(deps).setPromptSuppressed(value)).rejects.toThrow('Choose whether');
    expect(deps.writeSuppressed).not.toHaveBeenCalled();
  });

  it.each([null, {}, 1, 'mailto', 'file:///a.ics', undefined])('rejects an arbitrary native action target %j', async value => {
    await expect(new DefaultAppService(deps).requestDefault(value)).rejects.toThrow('Choose email or calendar');
    expect(deps.run).not.toHaveBeenCalled();
  });

  it('avoids another request when both applications are already default', async () => {
    vi.mocked(deps.isDefaultMail).mockReturnValue(true); vi.mocked(deps.run).mockResolvedValue('com.sarv.sarvinbox');
    const service = new DefaultAppService(deps);
    expect(await service.getStatus()).toMatchObject({ shouldPrompt: false });
    expect((await service.requestDefault('email')).outcome).toBe('default');
    expect((await service.requestDefault('calendar')).outcome).toBe('default');
    expect(deps.setDefaultMail).not.toHaveBeenCalled();
    expect(vi.mocked(deps.run).mock.calls.every(call => call[1].includes(MAC_CALENDAR_QUERY))).toBe(true);
  });
});

describe('platform-specific explicit requests', () => {
  it('verifies macOS email status rather than trusting the setter return value', async () => {
    const result = await new DefaultAppService(deps).requestDefault('email');
    expect(deps.setDefaultMail).toHaveBeenCalledOnce(); expect(result.outcome).toBe('requested');
    expect(result.state.email.status).toBe('not-default');
  });

  it('verifies .ics LaunchServices status after an accepted macOS request', async () => {
    vi.mocked(deps.run).mockResolvedValueOnce('com.apple.ical').mockResolvedValueOnce('0').mockResolvedValueOnce('com.sarv.sarvinbox');
    const result = await new DefaultAppService(deps).requestDefault('calendar');
    expect(deps.run).toHaveBeenNthCalledWith(2, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_CALENDAR_SET]);
    expect(result.outcome).toBe('default'); expect(result.state.calendar.status).toBe('default');
    expect(deps.setDefaultMail).not.toHaveBeenCalled();
    expect(deps.setDefaultCalendarLink).toHaveBeenNthCalledWith(1, 'webcal');
    expect(deps.setDefaultCalendarLink).toHaveBeenNthCalledWith(2, 'webcals');
  });

  it('reports a rejected macOS association without claiming success', async () => {
    vi.mocked(deps.run).mockResolvedValueOnce('com.apple.ical').mockResolvedValueOnce('-10814');
    await expect(new DefaultAppService(deps).requestDefault('calendar')).rejects.toThrow('did not accept');
    expect(deps.setDefaultCalendarLink).not.toHaveBeenCalled();
  });

  it.each(['darwin', 'win32'])('reports a partial %s calendar default when webcal links still use another app', async platform => {
    deps.platform = platform;
    vi.mocked(deps.run).mockResolvedValue(platform === 'darwin' ? 'com.sarv.sarvinbox' : `ProgId REG_SZ ${DEFAULT_APPS_ICS_PROG_ID}`);
    vi.mocked(deps.isDefaultCalendarLink).mockImplementation(scheme => scheme === 'webcal');
    expect(await new DefaultAppService(deps).getStatus()).toMatchObject({ shouldPrompt: true, calendar: { status: 'not-default', detail: expect.stringContaining('Some calendar links') } });
  });

  it('does not claim a macOS default from an empty LaunchServices result', async () => {
    vi.mocked(deps.run).mockResolvedValue('');
    expect(await new DefaultAppService(deps).getStatus()).toMatchObject({ calendar: { status: 'unknown' } });
    expect(MAC_CALENDAR_QUERY).toContain('ObjC.castRefToObject');
  });

  it('reports a failed native status check as unknown', async () => {
    vi.mocked(deps.run).mockRejectedValue(new Error('Unavailable'));
    expect(await new DefaultAppService(deps).getStatus()).toMatchObject({ calendar: { status: 'unknown', canRequest: true }, shouldPrompt: true });
  });

  it('reads Windows calendar UserChoice independently of email', async () => {
    deps.platform = 'win32'; vi.mocked(deps.run).mockResolvedValue(`\r\n    ProgId    REG_SZ    ${DEFAULT_APPS_ICS_PROG_ID}\r\n`);
    const state = await new DefaultAppService(deps).getStatus();
    expect(state.calendar).toMatchObject({ status: 'default', method: 'settings' }); expect(state.email.status).toBe('not-default');
  });

  it.each(['email', 'calendar'] as const)('opens Windows settings for %s without writing protected associations', async target => {
    deps.platform = 'win32'; vi.mocked(deps.run).mockResolvedValue('    ProgId REG_SZ Other.Calendar');
    const result = await new DefaultAppService(deps).requestDefault(target);
    expect(result.outcome).toBe('settings-opened'); expect(deps.openExternal).toHaveBeenCalledExactlyOnceWith('ms-settings:defaultapps');
    expect(deps.setDefaultMail).not.toHaveBeenCalled();
    expect(vi.mocked(deps.run).mock.calls.every(call => call[0] === 'reg.exe' && call[1][0] === 'query')).toBe(true);
  });

  it('does not infer a Windows default from a missing UserChoice value', async () => {
    deps.platform = 'win32'; vi.mocked(deps.run).mockResolvedValue('');
    expect(await new DefaultAppService(deps).getStatus()).toMatchObject({ calendar: { status: 'unknown', canRequest: true } });
  });

  it('only sets the requested Linux MIME after checking installed desktop integration', async () => {
    deps.platform = 'linux';
    vi.mocked(deps.run).mockImplementation(async (_file, args) => args[0] === 'default' ? '' : args.includes('text/calendar') ? DEFAULT_APPS_DESKTOP_ID : 'other.desktop');
    const service = new DefaultAppService(deps);
    expect((await service.requestDefault('email')).outcome).toBe('requested');
    expect(deps.run).toHaveBeenCalledWith('xdg-mime', ['default', DEFAULT_APPS_DESKTOP_ID, 'x-scheme-handler/mailto']);
    expect(deps.run).not.toHaveBeenCalledWith('xdg-mime', ['default', DEFAULT_APPS_DESKTOP_ID, 'text/calendar']);
    expect(deps.linuxDesktopInstalled).toHaveBeenCalled();
  });

  it('does not associate an unintegrated Linux AppImage or lose a registration race', async () => {
    deps.platform = 'linux'; vi.mocked(deps.linuxDesktopInstalled).mockResolvedValue(false);
    const service = new DefaultAppService(deps);
    expect((await service.requestDefault('calendar')).outcome).toBe('unsupported');
    expect(vi.mocked(deps.run).mock.calls.every(call => call[1][0] === 'query')).toBe(true);
    vi.mocked(deps.linuxDesktopInstalled).mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(service.requestDefault('calendar')).rejects.toThrow('desktop integration');
    expect(vi.mocked(deps.run).mock.calls.every(call => call[1][0] === 'query')).toBe(true);
  });

  it('checks and sets every Linux calendar association, and verifies the resulting choices', async () => {
    deps.platform = 'linux'; const selected = new Set<string>();
    vi.mocked(deps.run).mockImplementation(async (_file, args) => {
      if (args[0] === 'default') { selected.add(args[2]!); return ''; }
      return selected.has(args[2]!) ? DEFAULT_APPS_DESKTOP_ID : 'other.desktop';
    });
    expect((await new DefaultAppService(deps).requestDefault('calendar')).outcome).toBe('default');
    expect([...selected]).toEqual(['text/calendar', 'x-scheme-handler/webcal', 'x-scheme-handler/webcals']);
  });

  it('honestly reports unsupported platforms and unsupported settings launchers', async () => {
    deps.platform = 'freebsd'; const service = new DefaultAppService(deps);
    expect(await service.getStatus()).toMatchObject({ shouldPrompt: false, email: { status: 'unsupported', canRequest: false } });
    expect(await service.openSettings()).toEqual({ opened: false }); expect(deps.openExternal).not.toHaveBeenCalled();
  });
});
