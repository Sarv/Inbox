/**
 * Build-time configuration for the extension system.
 *
 * Which extensions ship "already there" is a product decision, not a code one,
 * so it lives in a JSON file (`apps/desktop/extensions.config.json`) that is
 * read at build and at first run rather than in a hardcoded list. Everything
 * named in `systemExtensions` is installed and enabled for a new profile
 * without the user going looking for it; everything else is opt-in from the
 * Browse tab.
 *
 * Nothing here is bundled INTO the app as source. A system extension is the
 * same artifact as any other — the same published `.tgz`, the same pinned
 * SHA-256, the same install path — it is just one the app fetches for you. That
 * is deliberate: an extension that shipped a different way would be an
 * extension the publishing pipeline never exercised.
 *
 * Parsing is total and defaults are safe: an unreadable or missing config
 * leaves the official registry configured and no system extensions, which
 * degrades to "the Browse tab works and nothing is preinstalled".
 */

import { isTrustedRegistryUrl } from './marketplace';

/**
 * The registry the app ships pointing at.
 *
 * The served index, not the pretty `registry.json` next to it in that
 * repository: it is a third the size, it leaves out fields nothing in the app
 * reads, and it keeps the download URL and the pinned digest in a per-extension
 * document fetched only for what the user chooses to install. The pretty file
 * stays published for people to read and review; nothing fetches it.
 */
export const OFFICIAL_REGISTRY_URL =
  'https://raw.githubusercontent.com/Sarv/SarvInbox-extensions/main/registry/index.json';

const EXTENSION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** More than this and a first run spends minutes downloading before it shows mail. */
const MAX_SYSTEM_EXTENSIONS = 16;

export interface ExtensionsConfig {
  /** Registry index URLs, most trusted first. The official one is always present. */
  registries: string[];
  /** Extension ids installed and enabled by default on a new profile. */
  systemExtensions: string[];
}

export const DEFAULT_EXTENSIONS_CONFIG: ExtensionsConfig = Object.freeze({
  registries: [OFFICIAL_REGISTRY_URL],
  systemExtensions: [],
}) as ExtensionsConfig;

export interface ParsedExtensionsConfig extends ExtensionsConfig {
  /** Entries that were dropped, with a reason, so the log can say what was ignored. */
  warnings: string[];
}

/**
 * Read an `extensions.config.json` document.
 *
 * The official registry is forced to the front of the list even if the config
 * omits or reorders it: `mergeRegistries` lets the earliest source win a clash
 * of ids, which is what stops a user-added registry from shadowing an official
 * extension with a build of its own.
 */
export function parseExtensionsConfig(raw: unknown): ParsedExtensionsConfig {
  const warnings: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_EXTENSIONS_CONFIG, warnings: ['config is not an object; using defaults'] };
  }
  const document = raw as Record<string, unknown>;

  const registries: string[] = [OFFICIAL_REGISTRY_URL];
  const rawRegistries = Array.isArray(document.registries) ? document.registries : [];
  for (const candidate of rawRegistries) {
    if (!isTrustedRegistryUrl(candidate)) {
      warnings.push(`registry "${String(candidate)}" is not an allowed https GitHub URL`);
      continue;
    }
    if (!registries.includes(candidate)) registries.push(candidate);
  }

  const systemExtensions: string[] = [];
  const rawSystem = Array.isArray(document.systemExtensions) ? document.systemExtensions : [];
  for (const candidate of rawSystem) {
    if (typeof candidate !== 'string' || !EXTENSION_ID.test(candidate)) {
      warnings.push(`systemExtensions entry "${String(candidate)}" is not a valid extension id`);
      continue;
    }
    if (systemExtensions.includes(candidate)) continue;
    if (systemExtensions.length >= MAX_SYSTEM_EXTENSIONS) {
      warnings.push(`more than ${MAX_SYSTEM_EXTENSIONS} systemExtensions; "${candidate}" and any after it ignored`);
      break;
    }
    systemExtensions.push(candidate);
  }

  return { registries, systemExtensions, warnings };
}
