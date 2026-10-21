import { savedSecretsProtected } from '../utils/secure-storage-status';

import { useSecureStorageStatus } from './useSecureStorageStatus';

/**
 * Saved protection metadata, rather than the current ability to use Keychain.
 * Unknown results stay null; an unavailable Keychain does not decrypt a file.
 */
export function useSecureStorageProtected(): boolean | null {
  return savedSecretsProtected(useSecureStorageStatus().status);
}
