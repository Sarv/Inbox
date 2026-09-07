/**
 * Minimal .env loader for the Electron main process.
 *
 * Secrets (Google OAuth client id/secret, Sarv dev overrides, etc.) are NOT
 * baked into source — they come from the environment. In local dev we read a
 * `.env` at the repo root (gitignored) so the app works without exporting vars
 * by hand. Dependency-free on purpose: keeps the lockfile untouched and avoids
 * pulling a runtime dep just to parse KEY=VALUE lines.
 *
 * Rules: shell-provided vars always win (we never overwrite an existing
 * process.env key), lines starting with `#` are comments, and surrounding
 * quotes are stripped. A missing file is a silent no-op (packaged builds rely
 * on real env vars / baked non-secret config).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export function loadDotEnv(candidatePaths: string[]): void {
  for (const filePath of candidatePaths) {
    if (!existsSync(filePath)) continue;
    try {
      const content = readFileSync(filePath, 'utf8');
      for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        if (!key || key in process.env) continue; // shell env wins
        let val = line.slice(eq + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
      return; // first file found wins
    } catch {
      // best-effort — ignore unreadable .env
    }
  }
}

/**
 * Default candidate locations, resolved from the built main file
 * (`apps/desktop/dist-electron/`): the desktop app dir and the repo root.
 */
export function defaultDotEnvPaths(): string[] {
  return [
    join(process.cwd(), '.env'),
    join(__dirname, '..', '.env'), // apps/desktop/.env
    join(__dirname, '..', '..', '..', '.env'), // repo root .env
  ];
}
