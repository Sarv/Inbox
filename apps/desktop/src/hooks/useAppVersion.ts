import { useEffect, useState } from 'react';

/**
 * Fetch the app version from the main process once on mount and return it as a
 * string. Empty string until the version has been fetched (or if the fetch
 * yields no data).
 */
export const useAppVersion = (): string => {
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    const fetchVersion = async () => {
      // Guard electronAPI itself (injected by the preload bridge) — an unguarded
      // `.app` threw "Cannot read properties of undefined (reading 'app')" when
      // the bridge wasn't ready / absent (SARV-INBOX-R).
      const result = await window.electronAPI?.app?.getVersion();
      if (result?.success && result.data) {
        setVersion(result.data);
      }
    };
    fetchVersion();
  }, []);

  return version;
};
