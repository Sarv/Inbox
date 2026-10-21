/** Metadata only: secret bytes, account identities and keys never cross IPC. */
export type SecureStorageEnvelope = 'encrypted' | 'plaintext' | 'missing' | 'unknown';

export interface SecureStorageStoreStatus {
  id: string;
  label: string;
  envelope: SecureStorageEnvelope;
  /** The enclosing database's key is protected by the operating system. */
  protectedByDatabase: boolean;
  protection: 'encrypted' | 'unprotected' | 'unknown' | 'missing';
}

export interface SecureStorageStatus {
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  /** Current ability to save secrets; not a verdict on previously saved data. */
  keyStore: 'available' | 'unavailable' | 'basic-text';
  databaseKey: SecureStorageEnvelope;
  /** Actual stored-key protection, including legacy Linux v10 obfuscation. */
  databaseKeyProtection: SecureStorageStoreStatus['protection'];
  /** null means no database was checked, false means an existing one could not be read. */
  databaseReadable: boolean | null;
  stores: SecureStorageStoreStatus[];
}
export interface SecureStorageAccessResult {
  outcome: 'authorized' | 'cancelled' | 'unavailable';
  status: number;
  restarting?: boolean;
}
