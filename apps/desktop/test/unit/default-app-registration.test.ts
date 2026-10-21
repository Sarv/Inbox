import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as {
  desktopName: string;
  productName: string;
  description: string;
  build: {
    protocols?: unknown;
    fileAssociations?: unknown;
    mac: { protocols: Array<{ schemes: string[]; role: string }>; fileAssociations: Array<{ ext: string; role: string; rank: string }> };
    win: { protocols?: unknown; fileAssociations?: unknown };
    linux: { syncDesktopName: boolean; executableName: string; mimeTypes: string[]; desktop: { entry: Record<string, string> } };
    nsis: { include: string; perMachine: boolean };
  };
};
const builderRoot = dirname(require.resolve('app-builder-lib/package.json'));
const nsisPath = fileURLToPath(new URL('../../build/default-apps.nsh', import.meta.url));
const source = readFileSync(nsisPath, 'utf8');
const script = source.split('\n').map(line => line.replace(/;.*$/, '')).join('\n');
const constants: Record<string, string> = Object.fromEntries([...script.matchAll(/^!define\s+(\w+)\s+"([^"]+)"$/gm)].map(match => [match[1]!, match[2]!]));
const expand = (value: string) => {
  for (let i = 0; i < 4; i++) value = value.replace(/\$\{(\w+)\}/g, (full, key: string) => constants[key] ?? full);
  return value;
};
const macro = (name: string) => script.match(new RegExp(`^!macro ${name}(?: [^\\n]*)?\\n([\\s\\S]*?)^!macroend`, 'm'))?.[1] ?? '';
const id = 'com.sarv.sarvinbox';
const mimeTypes = ['x-scheme-handler/mailto', 'x-scheme-handler/webcal', 'x-scheme-handler/webcals', 'text/calendar'];
const client = 'Software\\Clients\\Mail\\Sarv Inbox';

describe('registration-only default email and calendar capabilities', () => {
  it('declares mail and calendar handlers only in the macOS bundle', () => {
    expect(pkg.build.mac.protocols.flatMap(protocol => protocol.schemes).sort()).toEqual(['mailto', 'webcal', 'webcals']);
    expect(pkg.build.mac.protocols.every(protocol => protocol.role === 'Editor')).toBe(true);
    expect(pkg.build.mac.fileAssociations).toEqual([{ ext: 'ics', name: 'iCalendar calendar', role: 'Editor', rank: 'Alternate' }]);
    // A global or Windows fileAssociations entry invokes NSIS APP_ASSOCIATE,
    // which would overwrite the user's selected .ics default during install.
    expect(pkg.build.fileAssociations).toBeUndefined(); expect(pkg.build.win.fileAssociations).toBeUndefined();
    expect(pkg.build.protocols).toBeUndefined(); expect(pkg.build.win.protocols).toBeUndefined();
  });

  it('emits a matching Linux desktop filename, window identity and all four MIME handlers using installed builder 26', async () => {
    const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper.js') as {
      LinuxTargetHelper: new (packager: unknown) => { getDesktopFileName(): string; computeDesktopEntry(options: unknown): Promise<string> };
    };
    const options = structuredClone(pkg.build.linux);
    const helper = new LinuxTargetHelper({
      config: pkg.build, platformSpecificBuildOptions: options, executableName: options.executableName,
      info: { metadata: pkg }, fileAssociations: [],
      appInfo: { productName: pkg.productName, sanitizedProductName: 'Sarv Inbox', description: pkg.description },
    });
    expect(pkg.desktopName).toBe(`${id}.desktop`); expect(options.syncDesktopName).toBe(true);
    expect(helper.getDesktopFileName()).toBe(id);
    const entry = await helper.computeDesktopEntry(options);
    expect(entry).toContain(`StartupWMClass=${id}\n`);
    expect(entry).toContain(`MimeType=${mimeTypes.join(';')};\n`);
    expect(entry).toMatch(/^Exec=.*sarv-inbox"? %U$/m);
    expect(options.mimeTypes).toEqual(mimeTypes);
  });

  it('wires the custom NSIS include without changing the per-user installer default', () => {
    expect(pkg.build.nsis.include).toBe('build/default-apps.nsh');
    expect(resolve(fileURLToPath(new URL('../../', import.meta.url)), pkg.build.nsis.include)).toBe(nsisPath);
    expect(pkg.build.nsis.perMachine).toBe(false);
    expect(macro('customInstall')).not.toBe(''); expect(macro('customUnInstall')).not.toBe('');
  });

  it('registers unique app-owned ProgIDs and capabilities for each supported handler', () => {
    const install = expand(macro('customInstall'));
    for (const suffix of ['ics', 'mailto', 'webcal', 'webcals']) {
      expect(install).toContain(`!insertmacro sarvRegisterDefaultAppProgId "${suffix}"`);
    }
    expect(install).toContain(`WriteRegStr SHELL_CONTEXT "${client}\\Capabilities\\FileAssociations" ".ics" "${id}.ics"`);
    for (const scheme of ['mailto', 'webcal', 'webcals']) {
      expect(install).toContain(`WriteRegStr SHELL_CONTEXT "${client}\\Capabilities\\UrlAssociations" "${scheme}" "${id}.${scheme}"`);
      expect(install).toContain(`WriteRegStr SHELL_CONTEXT "Software\\Classes\\${id}.${scheme}" "URL Protocol" ""`);
    }
    expect(install).toContain(`WriteRegStr SHELL_CONTEXT "Software\\RegisteredApplications" "Sarv Inbox" "${client}\\Capabilities"`);
    expect(install).toContain(`WriteRegStr SHELL_CONTEXT "${client}\\Capabilities" "ApplicationName" "Sarv Inbox"`);
  });

  it('offers .ics through OpenWithProgids without claiming its unnamed default', () => {
    const install = expand(macro('customInstall'));
    expect(install).toContain(`WriteRegNone SHELL_CONTEXT "Software\\Classes\\.ics\\OpenWithProgids" "${id}.ics"`);
    expect(script).not.toMatch(/^\s*!insertmacro\s+APP_ASSOCIATE\b/m);
    expect(script).not.toMatch(/^\s*WriteReg\w+\s+\S+\s+"Software\\Classes\\\.ics"\s+""/m);
    expect(script).not.toMatch(/^\s*(?:WriteReg|DeleteReg)\w+[^\n]*UserChoice/m);
  });

  it('limits every registry write to app-owned keys, capability registration and the .ics OpenWith candidate', () => {
    const writes = [...script.matchAll(/^\s*WriteReg\w+\s+(\S+)\s+"([^"]+)"/gm)];
    expect(writes.length).toBeGreaterThan(10);
    for (const match of writes) {
      expect(match[1]).toBe('SHELL_CONTEXT');
      const key = expand(match[2]!);
      expect(key === client || key.startsWith(`${client}\\Capabilities`) || key.startsWith(`Software\\Classes\\${id}.`) ||
        key === 'Software\\Classes\\.ics\\OpenWithProgids' || key === 'Software\\RegisteredApplications', key).toBe(true);
    }
    // Registering an application's protocol ProgID is safe; writing the global
    // scheme key itself would replace the current mail/calendar client.
    expect(script).not.toMatch(/^\s*WriteReg\w+\s+\S+\s+"Software\\Classes\\(?:mailto|webcal|webcals)(?:\\|")/m);
  });

  it('quotes both executable and incoming target in installed app commands', () => {
    const register = macro('sarvRegisterDefaultAppProgId');
    expect(register).toContain('"$appExe" "%1"');
    expect(register).toContain('"$appExe",0');
    const builderInstall = readFileSync(resolve(builderRoot, 'templates/nsis/installSection.nsh'), 'utf8');
    expect(builderInstall.indexOf('StrCpy $appExe "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')).toBeLessThan(builderInstall.indexOf('!insertmacro customInstall'));
  });

  it('unregisters only entries still owned by this installed executable and preserves upgrade registrations', () => {
    const uninstall = expand(macro('customUnInstall'));
    const unregister = expand(macro('sarvUnregisterDefaultAppProgId'));
    expect(uninstall).toContain('${IfNot} ${isUpdated}');
    expect(uninstall).toContain('ReadRegStr $R0 SHELL_CONTEXT');
    expect(uninstall).toContain('"$INSTDIR\\${APP_EXECUTABLE_FILENAME}",0');
    expect(unregister).toContain('"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" "%1"');
    expect(unregister).toContain(`DeleteRegValue SHELL_CONTEXT "Software\\Classes\\.ics\\OpenWithProgids" "${id}.ics"`);
    // BUILD_UNINSTALLER has no appExe variable in electron-builder 26.
    expect(uninstall).not.toContain('$appExe'); expect(unregister).not.toContain('$appExe');
    expect(script).not.toMatch(/^\s*DeleteRegKey(?:\s+\/\w+)?\s+\S+\s+"Software\\Classes\\(?:\.ics|mailto|webcal|webcals)"/m);
  });
});
