/**
 * Extension Loader
 *
 * Handles loading extension manifests, validation, and module resolution.
 */

import * as fs from 'fs';
import * as path from 'path';

import { logger } from '../utils/logger';

import type {
  ExtensionManifest,
  ExtensionPermission,
  ExtensionContributions,
  WorkflowContribution,
  SettingContribution,
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
  entryPoint: string;
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

  // Resolve entry point
  const entryPoint = resolveEntryPoint(extensionPath, manifest.main);

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
          builtin: extConfig.builtin,
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

  if (!manifest.main) {
    errors.push('Missing required field: main');
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
 * Resolve extension entry point to absolute path
 */
function resolveEntryPoint(extensionPath: string, mainPath: string): string {
  // Handle relative paths
  let entryPoint = mainPath;
  if (entryPoint.startsWith('./')) {
    entryPoint = entryPoint.slice(2);
  }

  const absolutePath = path.join(extensionPath, entryPoint);

  // Check if file exists
  if (!fs.existsSync(absolutePath)) {
    // Try adding .js extension
    if (fs.existsSync(`${absolutePath}.js`)) {
      return `${absolutePath}.js`;
    }
    // Try index.js in directory
    const indexPath = path.join(absolutePath, 'index.js');
    if (fs.existsSync(indexPath)) {
      return indexPath;
    }

    throw new Error(`Entry point not found: ${mainPath} (resolved to ${absolutePath})`);
  }

  return absolutePath;
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
