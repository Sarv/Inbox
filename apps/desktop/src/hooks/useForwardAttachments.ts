import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import type { AttachmentFile } from '../components/useCompose';
import { loadForwardAttachments, type AttachmentSource } from '../utils/compose-attachments';

/** Owns original-file loading for both forward composers. Drafts already carry
 * the user's chosen files, and a completed load never reruns on metadata edits. */
export function useForwardAttachments({ source, restoredDraft, setAttachments }: {
  source?: AttachmentSource;
  restoredDraft: boolean;
  setAttachments: Dispatch<SetStateAction<AttachmentFile[]>>;
}) {
  const active = !!source && !restoredDraft;
  const key = active ? `${source.id}\u0001${source.accountId ?? ''}` : '';
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState({ key, loading: active, error: false });
  const prefilled = useRef<AttachmentFile[]>([]);
  const pending = useRef<Promise<AttachmentFile[]> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const previous = prefilled.current;
    if (previous.length > 0) setAttachments((files) => files.filter((file) => !previous.includes(file)));
    prefilled.current = [];
    if (!active || !source) {
      pending.current = null;
      setStatus({ key, loading: false, error: false });
      return;
    }
    setStatus({ key, loading: true, error: false });
    const load = loadForwardAttachments(source);
    pending.current = load;
    void load.then((files) => {
      if (cancelled) return;
      prefilled.current = files;
      setAttachments((current) => [...current, ...files]);
      if (pending.current === load) pending.current = null;
      setStatus({ key, loading: false, error: false });
    }).catch(() => {
      if (!cancelled) setStatus({ key, loading: false, error: true });
    });
    return () => { cancelled = true; };
    // The source identity owns this load. A body/metadata refresh must not put
    // back a file the user removed after loading it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, setAttachments]);

  const loading = active && (status.key !== key || status.loading);
  const error = active && status.key === key && status.error;
  return {
    loading, error, blocked: loading || error,
    retry: () => setAttempt((value) => value + 1),
    // Autosave/close may begin before the original bytes arrive. Await that
    // same load so a saved forward cannot silently omit its original files.
    prepareAttachments: async (files: AttachmentFile[] | undefined) => {
      const load = pending.current;
      if (!load) return files;
      const loaded = await load;
      return [...(files ?? []), ...loaded.filter((file) => !files?.includes(file))];
    },
  };
}
