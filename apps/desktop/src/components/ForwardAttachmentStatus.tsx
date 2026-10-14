export function ForwardAttachmentStatus({ loading, error, onRetry }: {
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  if (!loading && !error) return null;
  return (
    <div className="px-3 py-2 border-t border-border text-xs text-muted-foreground" role={error ? 'alert' : 'status'}>
      {loading ? 'Loading forwarded attachments…' : (
        <>
          Could not load forwarded attachments. Retry before sending.
          <button type="button" className="ml-2 underline text-primary" onClick={onRetry}>Retry attachments</button>
        </>
      )}
    </div>
  );
}
