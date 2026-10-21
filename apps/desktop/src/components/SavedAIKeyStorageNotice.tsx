import { useSecureStorageStatus } from '../hooks/useSecureStorageStatus';
import { credentialStoreProtection } from '../utils/secure-storage-status';

/** A plaintext inner envelope may still be protected by the encrypted database. */
export function SavedAIKeyStorageNotice({ as: Tag = 'p', className }: { as?: 'p' | 'dd'; className?: string }) {
  const { status, loading } = useSecureStorageStatus();
  const protection = credentialStoreProtection(status, 'ai-keys');
  if (protection === 'encrypted') return null;
  return <Tag role="status" className={className}>{loading ? 'API key saved. Checking storage protection…' : protection === 'unprotected' ? 'Some saved AI key data is not protected at rest. Review credential storage under Security → Overview.' : 'The API key was saved, but its at-rest protection could not be verified. Check Security → Overview.'}</Tag>;
}
