/* Types for windows-signing.mjs — see userdata-dirs.d.mts for why these exist. */

import type { X509Certificate } from 'node:crypto';

export declare const DEFAULT_CONFIG_PATH: string;
export declare const SIGNING_TOKEN_ENV: string;
export declare const JSIGN_JAR_ENV: string;
export declare const CODE_SIGNING_EKU: string;
export declare const SIGNING_HASH: string;
export declare const TIMESTAMP_ATTEMPTS: number;
export declare const TIMESTAMP_RETRY_WAIT_SECONDS: number;
export declare const DEFAULT_UNPACKED_DIRS: string[];

export interface DisabledSigning {
  enabled: false;
  config: Record<string, any>;
  configPath: string;
  chainPath: string;
}
export interface EnabledSigning {
  enabled: true;
  config: Record<string, any>;
  configPath: string;
  chainPath: string;
  /** The certificate CN; always publisherNames[0]. */
  publisher: string;
  /** Every name app-update.yml pins, the CN first. */
  publisherNames: string[];
  leaf: { subject: string; fingerprint256: string; validTo: string };
}
export type LoadedSigning = DisabledSigning | EnabledSigning;

export declare function configShapeProblems(raw: unknown): string[];
export declare function enabledConfigProblems(config: Record<string, any>): string[];
export declare function splitPemCertificates(text: string): string[];
export declare function selectSigningCertificate(certificates: X509Certificate[]): X509Certificate;
export declare function publicKeySha256(certificate: X509Certificate): string;
export declare function publisherFromCertificate(certificate: X509Certificate): string;
export declare function loadWindowsSigningConfig(
  configPath?: string,
  io?: { now?: Date; readFile?: (file: string) => string; exists?: (file: string) => boolean }
): LoadedSigning;

export interface Signer {
  storetype: 'GOOGLECLOUD' | 'PKCS12';
  keystore: string;
  alias?: string;
  certfile?: string;
  storepassEnv: string;
  keypassEnv?: string;
}
export interface SigningSettings {
  timestampUrls: string[];
  programName: string;
  programUrl: string;
}
export declare function googleCloudSigner(loaded: EnabledSigning): Signer;
export declare function pkcs12Signer(options: {
  keystore: string;
  passwordEnv: string;
  alias?: string;
}): Signer;
export declare function signingSettings(config: Record<string, any>): SigningSettings;
export declare function jsignArgs(options: {
  jar: string;
  signer: Signer;
  file: string;
  settings: SigningSettings;
}): string[];
export declare function classifyJsignFailure(
  output: string,
  error?: { code?: unknown; killed?: boolean }
): 'transient' | 'permanent';

export type CertificateTableRead =
  | { pe: false }
  | { pe: true; format: string; hasTable: boolean; signed: boolean; problem: string | null };
export declare function readFileCertificateTable(file: string): CertificateTableRead;
export declare function sha256File(file: string): string;

export type Run = (file: string, args: string[], options: object) => Promise<unknown>;
export interface SignResult {
  status: 'signed' | 'skipped';
  attempts: number;
}
export declare function signPeFile(options: {
  file: string;
  hash?: string;
  signer: Signer;
  settings: SigningSettings;
  jar: string;
  java?: string;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  retryDelaysMs?: number[];
  timeoutMs?: number;
}): Promise<SignResult>;

export interface BuilderSignConfiguration {
  path: string;
  hash?: string;
  isNest?: boolean;
  options?: Record<string, any>;
}
export declare function builderOptionsProblems(
  configuration: Omit<BuilderSignConfiguration, 'path'>,
  publisherNames: string[]
): string[];
export interface HookState {
  loaded?: LoadedSigning;
  disabledLogged?: boolean;
  verifiedJar?: string;
}
export declare function electronBuilderSign(
  configuration: BuilderSignConfiguration,
  deps?: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    log?: (message: string) => void;
    state?: HookState;
    now?: Date;
    run?: Run;
    sleep?: (ms: number) => Promise<void>;
    retryDelaysMs?: number[];
  }
): Promise<SignResult | { status: 'disabled' }>;

export type PeFileKind = 'own' | 'other' | 'unexpected';
export interface AuthenticodeResult {
  path: string;
  status: string;
  statusMessage: string | null;
  signerSubject: string | null;
  timeStamperSubject: string | null;
  /** SignerCertificate.Thumbprint (SHA-1, as Windows shows it). */
  signerThumbprint?: string | null;
  /** SHA-256 of the signer certificate's DER, uppercase hex. */
  signerSha256?: string | null;
}
export declare function peFileKind(
  file: string,
  where?: { appDirs?: string[]; releaseDir?: string }
): PeFileKind;
export declare function parseAuthenticodeJson(stdout: string): AuthenticodeResult[];
export declare function subjectCommonName(subject: string | null): string | null;
export declare function evaluateSignatures(
  entries: Array<{ path: string; kind: PeFileKind; result: AuthenticodeResult | undefined }>,
  publisherNames: string[],
  leaf?: { leafSha256?: string }
): { problems: string[]; upstream: string[]; ok: number };
export declare function appUpdatePublisherProblem(
  document: unknown,
  status: { enabled: boolean; publisherNames?: string[] },
  where: string
): string | null;
export declare function collectReleasePeFiles(
  releaseDir: string,
  unpackedDirs?: string[]
): { files: Array<{ path: string; kind: PeFileKind }>; problems: string[] };
export declare function queryAuthenticode(
  files: string[],
  deps?: {
    run?: (file: string, args: string[], options: object) => Promise<{ stdout: string }>;
    tmpDir?: string;
  }
): Promise<AuthenticodeResult[]>;
export declare function verifyWindowsRelease(options: {
  releaseDir: string;
  status: { enabled: boolean; publisherNames?: string[]; leafSha256?: string };
  unpackedDirs?: string[];
  query?: (files: string[]) => Promise<AuthenticodeResult[]>;
}): Promise<{ problems: string[]; warnings: string[]; notes: string[]; checked: number }>;

export declare function formatGithubOutput(outputs: Record<string, string>): string;
export declare function statusOutputs(loaded: LoadedSigning): Record<string, string>;

export declare const CONFIG_PATH_IN_REPO: string;
export type PreviousRelease =
  | { kind: 'none' }
  | { kind: 'predates-signing'; tag: string }
  | { kind: 'config'; tag: string; publisherNames: string[] };
export type GhRun = (file: string, args: string[], options: object) => Promise<{ stdout: unknown }>;
export declare function previousConfigProblems(raw: unknown): string[];
export declare function lookupPreviousRelease(options: {
  repository: string;
  run?: GhRun;
}): Promise<PreviousRelease>;
export declare function describePreviousRelease(previous: PreviousRelease): string;
export declare function previousReleaseProblems(
  previous: PreviousRelease,
  current: LoadedSigning
): string[];
export declare function fetchJsign(options: {
  jsign: { version: string; url: string; sha256: string };
  destDir: string;
  fetchImpl?: typeof fetch;
}): Promise<string>;

export interface CliIo {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  error?: (message: string) => void;
  configPath?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  query?: (files: string[]) => Promise<AuthenticodeResult[]>;
  /** Runs `gh` for --previous-release. */
  run?: GhRun;
}
export declare function windowsSigningCli(argv: string[], io?: CliIo): Promise<number>;
export declare function verifyWinSignaturesCli(argv: string[], io?: CliIo): Promise<number>;
export declare function verifyPeSignedCli(argv: string[], io?: CliIo): Promise<number>;
