/**
 * Extension Loader
 *
 * Handles loading extension manifests, validation, and module resolution.
 */

import * as fs from 'fs';
import * as path from 'path';

import { logger } from '../utils/logger';

import { SDK_HOST } from './panel-assets';
import type {
  ExtensionManifest,
  ExtensionPermission,
  ExtensionContributions,
  WorkflowContribution,
  SettingContribution,
  PanelContribution,
  CapabilityContribution,
} from './types';

/** Manifest filename */
export const MANIFEST_FILENAME = 'sarvinbox-extension.json';

/** Alternative manifest filename (for npm compatibility) */
export const ALT_MANIFEST_FILENAME = 'package.json';

/** Extension manifest fields in package.json */
export const PACKAGE_JSON_EXTENSION_KEY = 'sarvinboxExtension';

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Loaded extension info
 */
export interface LoadedExtension {
  manifest: ExtensionManifest;
  path: string;
  /**
   * Absolute path to the module the sandbox loads, or undefined for an
   * extension that is only UI — a folder of HTML with no background code.
   */
  entryPoint?: string;
}

/**
 * Load and validate an extension manifest from a directory
 */
export async function loadExtension(extensionPath: string): Promise<LoadedExtension> {
  // Check if path exists
  if (!fs.existsSync(extensionPath)) {
    throw new Error(`Extension path does not exist: ${extensionPath}`);
  }

  const stats = fs.statSync(extensionPath);
  if (!stats.isDirectory()) {
    throw new Error(`Extension path is not a directory: ${extensionPath}`);
  }

  // Try loading manifest
  const manifest = await loadManifest(extensionPath);

  // Validate manifest
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Invalid extension manifest:\n${validation.errors.join('\n')}`);
  }

  // Log warnings
  for (const warning of validation.warnings) {
    logger.warn(`Extension '${manifest.id}': ${warning}`);
  }

  // Resolve entry point. Absent for a panel-only extension, which has no
  // background code to run at all.
  const entryPoint = resolveEntryPoint(extensionPath, manifest);

  return {
    manifest,
    path: extensionPath,
    entryPoint,
  };
}

/**
 * Load manifest from extension directory
 */
async function loadManifest(extensionPath: string): Promise<ExtensionManifest> {
  // Try sarvinbox-extension.json first
  const manifestPath = path.join(extensionPath, MANIFEST_FILENAME);
  if (fs.existsSync(manifestPath)) {
    const content = fs.readFileSync(manifestPath, 'utf-8');
    try {
      return JSON.parse(content) as ExtensionManifest;
    } catch (error) {
      throw new Error(`Failed to parse ${MANIFEST_FILENAME}: ${error}`);
    }
  }

  // Try package.json with sarvinboxExtension field
  const packagePath = path.join(extensionPath, ALT_MANIFEST_FILENAME);
  if (fs.existsSync(packagePath)) {
    const content = fs.readFileSync(packagePath, 'utf-8');
    try {
      const pkg = JSON.parse(content);
      if (pkg[PACKAGE_JSON_EXTENSION_KEY]) {
        // Merge package.json fields with extension config
        const extConfig = pkg[PACKAGE_JSON_EXTENSION_KEY];
        return {
          id: extConfig.id || pkg.name,
          name: extConfig.name || pkg.name,
          version: pkg.version,
          description: extConfig.description || pkg.description,
          author: extConfig.author || (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name),
          authorEmail: extConfig.authorEmail || (typeof pkg.author === 'object' ? pkg.author?.email : undefined),
          repository: pkg.repository?.url || pkg.repository,
          homepage: pkg.homepage,
          license: pkg.license,
          main: extConfig.main || pkg.main || './dist/index.js',
          engines: extConfig.engines || { sarvinbox: '*' },
          permissions: extConfig.permissions || [],
          contributes: extConfig.contributes,
          keywords: extConfig.keywords || pkg.keywords,
          icon: extConfig.icon,
        };
      }
    } catch (error) {
      throw new Error(`Failed to parse ${ALT_MANIFEST_FILENAME}: ${error}`);
    }
  }

  throw new Error(
    `No extension manifest found. Expected ${MANIFEST_FILENAME} or ${ALT_MANIFEST_FILENAME} with '${PACKAGE_JSON_EXTENSION_KEY}' field.`
  );
}

/**
 * Validate extension manifest
 */
export function validateManifest(manifest: ExtensionManifest): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Required fields
  if (!manifest.id) {
    errors.push('Missing required field: id');
  } else if (!/^[a-z0-9-]+$/.test(manifest.id)) {
    errors.push('Invalid id: must be lowercase alphanumeric with hyphens only');
  } else if (manifest.id === SDK_HOST) {
    // The panel scheme serves the app's own SDK from this host. An extension
    // installed under it would be addressed by the same URLs and could replace
    // the SDK every other extension's panel loads.
    errors.push(`Invalid id: '${SDK_HOST}' is reserved by the app`);
  }

  if (!manifest.name) {
    errors.push('Missing required field: name');
  }

  if (!manifest.version) {
    errors.push('Missing required field: version');
  } else if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
    warnings.push('Version should follow semantic versioning (e.g., "1.0.0")');
  }

  if (!manifest.description) {
    warnings.push('Missing description');
  }

  if (!manifest.author) {
    warnings.push('Missing author');
  }

  // `main` is optional, on purpose, and the manifest alone cannot say whether
  // that is a problem: a panel-only extension is a folder of HTML with no
  // background code, and a no-build extension just puts its code in `index.js`
  // and never says so. Only the loader can see which of those it is, so it
  // makes the call once it has the folder in front of it.
  if (!manifest.main && !manifest.contributes?.panels?.length) {
    warnings.push(
      'No main and no contributes.panels — the loader will look for index.js in the extension folder'
    );
  }

  if (!manifest.engines) {
    errors.push('Missing required field: engines');
  } else if (!manifest.engines.sarvinbox) {
    errors.push('Missing required field: engines.sarvinbox');
  }

  if (!manifest.permissions) {
    errors.push('Missing required field: permissions');
  } else if (!Array.isArray(manifest.permissions)) {
    errors.push('permissions must be an array');
  } else {
    // Validate each permission
    const validPermissions = new Set<ExtensionPermission>([
      'email:read',
      'email:label',
      'email:flag',
      'email:move',
      'email:delete',
      'ai:use',
      'storage:local',
      'network:fetch',
      'settings:read',
      'settings:write',
      'ui:notify',
      'ui:panel',
    ]);

    for (const permission of manifest.permissions) {
      if (!validPermissions.has(permission as ExtensionPermission)) {
        errors.push(`Invalid permission: ${permission}`);
      }
    }
  }

  // Validate contributions
  if (manifest.contributes) {
    validateContributions(manifest.contributes, errors, warnings);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate contributions section
 */
function validateContributions(
  contributes: ExtensionContributions,
  errors: string[],
  warnings: string[]
): void {
  // Validate workflows
  if (contributes.workflows) {
    if (!Array.isArray(contributes.workflows)) {
      errors.push('contributes.workflows must be an array');
    } else {
      for (let i = 0; i < contributes.workflows.length; i++) {
        validateWorkflowContribution(contributes.workflows[i], i, errors, warnings);
      }
    }
  }

  // Validate settings
  if (contributes.settings) {
    if (!Array.isArray(contributes.settings)) {
      errors.push('contributes.settings must be an array');
    } else {
      for (let i = 0; i < contributes.settings.length; i++) {
        validateSettingContribution(contributes.settings[i], i, errors, warnings);
      }
    }
  }

  // Validate panels
  if (contributes.panels) {
    if (!Array.isArray(contributes.panels)) {
      errors.push('contributes.panels must be an array');
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < contributes.panels.length; i++) {
        validatePanelContribution(contributes.panels[i], i, seen, errors, warnings);
      }
    }
  }

  // Validate capabilities
  if (contributes.capabilities) {
    if (!Array.isArray(contributes.capabilities)) {
      errors.push('contributes.capabilities must be an array');
    } else {
      const seen = new Set<string>();
      for (let i = 0; i < contributes.capabilities.length; i++) {
        validateCapabilityContribution(contributes.capabilities[i], i, seen, errors);
      }
    }
  }

  // Validate events
  if (contributes.events) {
    if (!Array.isArray(contributes.events)) {
      errors.push('contributes.events must be an array');
    } else {
      const validEvents = [
        'email:received',
        'email:synced',
        'email:body-ready',
        'email:processed',
        'email:labeled',
        'email:flagged',
        'sync:started',
        'sync:progress',
        'sync:completed',
        'sync:error',
        'workflow:started',
        'workflow:completed',
        'workflow:error',
      ];

      for (const event of contributes.events) {
        if (!validEvents.includes(event)) {
          warnings.push(`Unknown event type: ${event}`);
        }
      }
    }
  }
}

/**
 * Validate a panel contribution.
 *
 * `entry` and `icon` are paths the app will later turn into URLs, so they are
 * checked here, at load time, rather than at request time: a manifest that
 * points outside its own folder is rejected before the extension is ever
 * installed, and the protocol handler's own containment check becomes the
 * second line rather than the only one.
 */
/**
 * One `contributes.capabilities` entry.
 *
 * A capability is how the app finds an extension without naming it, so a
 * malformed entry is an error rather than a warning: it would leave a feature
 * looking unprovided with nothing to say why. Two entries for the same id in
 * ONE manifest are rejected too — across extensions a duplicate is a
 * competition the host resolves by priority, but within a single manifest it
 * is simply a mistake about which export serves the id.
 */
function validateCapabilityContribution(
  capability: CapabilityContribution,
  index: number,
  seen: Set<string>,
  errors: string[]
): void {
  const where = `contributes.capabilities[${index}]`;

  if (!capability || typeof capability !== 'object') {
    errors.push(`${where} must be an object`);
    return;
  }

  if (!capability.id || typeof capability.id !== 'string') {
    errors.push(`${where}.id is required`);
  } else if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(capability.id)) {
    errors.push(
      `${where}.id must be lowercase dot-separated words, e.g. 'thread.summarize'`
    );
  } else if (seen.has(capability.id)) {
    errors.push(`${where}.id '${capability.id}' is declared twice`);
  } else {
    seen.add(capability.id);
  }

  if (!capability.export || typeof capability.export !== 'string') {
    errors.push(`${where}.export is required — the name on context.exports that serves it`);
  }

  if (capability.priority !== undefined && typeof capability.priority !== 'number') {
    errors.push(`${where}.priority must be a number`);
  }
}

function validatePanelContribution(
  panel: PanelContribution,
  index: number,
  seen: Set<string>,
  errors: string[],
  warnings: string[]
): void {
  const prefix = `contributes.panels[${index}]`;

  if (!panel.id) {
    errors.push(`${prefix}: Missing required field 'id'`);
  } else if (!/^[a-z0-9-]+$/.test(panel.id)) {
    errors.push(`${prefix}: Invalid id '${panel.id}' - must be lowercase alphanumeric with hyphens`);
  } else if (seen.has(panel.id)) {
    // Two panels with one id would give the app no way to say which to open.
    errors.push(`${prefix}: Duplicate panel id '${panel.id}'`);
  } else {
    seen.add(panel.id);
  }

  if (!panel.title) {
    errors.push(`${prefix}: Missing required field 'title'`);
  }

  if (!panel.entry) {
    errors.push(`${prefix}: Missing required field 'entry'`);
  } else if (!isContainedRelativePath(panel.entry)) {
    errors.push(`${prefix}: entry must be a relative path inside the extension folder`);
  } else if (!/\.html?$/i.test(panel.entry)) {
    errors.push(`${prefix}: entry must be an .html file`);
  }

  if (panel.icon && !isContainedRelativePath(panel.icon)) {
    errors.push(`${prefix}: icon must be a relative path inside the extension folder`);
  }

  if (panel.surface !== 'sidebar' && panel.surface !== 'modal') {
    errors.push(`${prefix}: surface must be 'sidebar' or 'modal'`);
  }

  if (panel.autoOpen && panel.surface === 'modal') {
    // A dialog that opens itself every time a message is read would make the
    // app unusable; say so rather than letting the author find out from users.
    warnings.push(`${prefix}: autoOpen is ignored for a modal panel`);
  }

  if (panel.width !== undefined && (typeof panel.width !== 'number' || panel.width <= 0)) {
    errors.push(`${prefix}: width must be a positive number`);
  }
}

/**
 * True when `candidate` stays inside the folder it is relative to.
 *
 * Rejects absolute paths, Windows drive letters, UNC paths, backslashes (which
 * are a legal filename character on Linux but a separator on Windows, so a
 * manifest using them would mean different things on different machines) and
 * any `..` segment.
 */
function isContainedRelativePath(candidate: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (candidate.startsWith('/') || candidate.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(candidate)) return false;
  if (candidate.includes('\\')) return false;
  return !candidate.split('/').includes('..');
}

/**
 * Validate workflow contribution
 */
function validateWorkflowContribution(
  workflow: WorkflowContribution,
  index: number,
  errors: string[],
  warnings: string[]
): void {
  const prefix = `contributes.workflows[${index}]`;

  if (!workflow.id) {
    errors.push(`${prefix}: Missing required field 'id'`);
  } else if (!/^[a-z0-9-]+$/.test(workflow.id)) {
    errors.push(`${prefix}: Invalid id '${workflow.id}' - must be lowercase alphanumeric with hyphens`);
  }

  if (!workflow.name) {
    errors.push(`${prefix}: Missing required field 'name'`);
  }

  if (workflow.priority === undefined) {
    warnings.push(`${prefix}: Missing priority, will default to 50`);
  } else if (typeof workflow.priority !== 'number') {
    errors.push(`${prefix}: priority must be a number`);
  } else if (workflow.priority < 0 || workflow.priority > 1000) {
    warnings.push(`${prefix}: priority ${workflow.priority} is unusual (typical range: 0-200)`);
  }
}

/**
 * Validate setting contribution
 */
function validateSettingContribution(
  setting: SettingContribution,
  index: number,
  errors: string[],
  warnings: string[]
): void {
  const prefix = `contributes.settings[${index}]`;

  if (!setting.key) {
    errors.push(`${prefix}: Missing required field 'key'`);
  }

  if (!setting.type) {
    errors.push(`${prefix}: Missing required field 'type'`);
  } else {
    const validTypes = ['string', 'number', 'boolean', 'array', 'object'];
    if (!validTypes.includes(setting.type)) {
      errors.push(`${prefix}: Invalid type '${setting.type}'`);
    }
  }

  if (setting.default === undefined) {
    warnings.push(`${prefix}: Missing default value`);
  }

  if (!setting.description) {
    warnings.push(`${prefix}: Missing description`);
  }

  // Type-specific validations
  if (setting.type === 'number') {
    if (setting.minimum !== undefined && setting.maximum !== undefined) {
      if (setting.minimum > setting.maximum) {
        errors.push(`${prefix}: minimum (${setting.minimum}) cannot be greater than maximum (${setting.maximum})`);
      }
    }
  }

  if (setting.type === 'string' && setting.enum) {
    if (!Array.isArray(setting.enum)) {
      errors.push(`${prefix}: enum must be an array`);
    } else if (setting.default !== undefined && !setting.enum.includes(setting.default as string)) {
      warnings.push(`${prefix}: default value '${setting.default}' is not in enum`);
    }
  }
}

/**
 * Where an extension's code lives when the manifest does not say.
 *
 * In order of how an author is likely to have arranged the folder: a plain
 * `index.js` written by hand, then the two places a bundler puts its output.
 * Trying these is what lets a no-build extension be a folder with a manifest
 * and a file in it, with no `main` and no build step to produce one.
 */
const IMPLICIT_ENTRY_POINTS = ['index.js', 'dist/index.js', 'src/index.js'];

/**
 * Resolve extension entry point to an absolute path.
 *
 * Returns undefined when the extension declares panels and ships no module —
 * a UI-only extension is a legitimate shape, not a broken one. An extension
 * with neither still throws: silently activating nothing would leave the user
 * with an installed extension that does nothing and says nothing.
 */
function resolveEntryPoint(
  extensionPath: string,
  manifest: ExtensionManifest
): string | undefined {
  const candidates = manifest.main ? [manifest.main] : IMPLICIT_ENTRY_POINTS;

  for (const candidate of candidates) {
    const relative = candidate.startsWith('./') ? candidate.slice(2) : candidate;
    const absolutePath = path.join(extensionPath, relative);

    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      return absolutePath;
    }
    // A `main` written without its extension, the way a bundler config does.
    if (fs.existsSync(`${absolutePath}.js`)) {
      return `${absolutePath}.js`;
    }
    // A `main` naming a directory rather than the file inside it.
    const indexPath = path.join(absolutePath, 'index.js');
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }
  }

  if (manifest.contributes?.panels?.length) {
    return undefined;
  }

  throw new Error(
    `Entry point not found: ${manifest.main ?? IMPLICIT_ENTRY_POINTS.join(', ')} (in ${extensionPath})`
  );
}

/**
 * Discover extensions in a directory
 */
export async function discoverExtensions(extensionsDir: string): Promise<LoadedExtension[]> {
  if (!fs.existsSync(extensionsDir)) {
    return [];
  }

  const extensions: LoadedExtension[] = [];
  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const extensionPath = path.join(extensionsDir, entry.name);

    try {
      const loaded = await loadExtension(extensionPath);
      extensions.push(loaded);
      logger.info(`Discovered extension: ${loaded.manifest.id} v${loaded.manifest.version}`);
    } catch (error) {
      // A manifest-only (declarative) extension with no code file can't
      // contribute a working workflow anyway — skip it quietly instead of
      // WARNing on every startup. (These built-in stubs are vestigial; the real
      // categorization runs in the pipeline, not via an extension.) Anything
      // else is a genuine load error worth surfacing.
      const msg = String((error as { message?: string })?.message ?? error);
      if (msg.includes('Entry point not found')) {
        logger.debug(`Skipping code-less extension at ${extensionPath}`);
      } else {
        logger.warn(`Failed to load extension from ${extensionPath}:`, error);
      }
    }
  }

  return extensions;
}

/**
 * Check if a version satisfies a semver range
 * Simple implementation for basic version checking
 */
export function satisfiesVersion(version: string, range: string): boolean {
  if (range === '*') {
    return true;
  }

  // Parse version parts
  const versionParts = version.split('.').map((p) => parseInt(p, 10));
  const [vMajor, vMinor = 0, vPatch = 0] = versionParts;

  // Handle caret range (^1.2.3)
  if (range.startsWith('^')) {
    const rangeParts = range.slice(1).split('.').map((p) => parseInt(p, 10));
    const [rMajor, rMinor = 0, rPatch = 0] = rangeParts;

    // Same major version, >= minor.patch
    return vMajor === rMajor && (vMinor > rMinor || (vMinor === rMinor && vPatch >= rPatch));
  }

  // Handle tilde range (~1.2.3)
  if (range.startsWith('~')) {
    const rangeParts = range.slice(1).split('.').map((p) => parseInt(p, 10));
    const [rMajor, rMinor = 0, rPatch = 0] = rangeParts;

    // Same major.minor version, >= patch
    return vMajor === rMajor && vMinor === rMinor && vPatch >= rPatch;
  }

  // Handle >= range
  if (range.startsWith('>=')) {
    const rangeParts = range.slice(2).split('.').map((p) => parseInt(p, 10));
    const [rMajor, rMinor = 0, rPatch = 0] = rangeParts;

    if (vMajor > rMajor) return true;
    if (vMajor < rMajor) return false;
    if (vMinor > rMinor) return true;
    if (vMinor < rMinor) return false;
    return vPatch >= rPatch;
  }

  // Exact match
  const rangeParts = range.split('.').map((p) => parseInt(p, 10));
  const [rMajor, rMinor = 0, rPatch = 0] = rangeParts;

  return vMajor === rMajor && vMinor === rMinor && vPatch === rPatch;
}
