import { Loader2, X, FileSignature } from 'lucide-react';

import type { SignatureDetectionResult } from '../../services/ai-service';

interface SignatureDetectionModalProps {
  email: any;
  result: SignatureDetectionResult | null;
  detecting: boolean;
  onDetect?: () => void;
  onSave: () => void;
  onClose: () => void;
}

export function SignatureDetectionModal({
  email,
  result,
  detecting,
  onSave,
  onClose,
}: SignatureDetectionModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col m-4">
        {/* Modal Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <FileSignature className="h-5 w-5 text-primary" />
            <h3 className="text-lg font-semibold">Signature Detection</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-accent rounded transition-colors"
            title="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-auto p-4">
          {detecting ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
              <div className="text-sm text-muted-foreground">Detecting signature...</div>
              <div className="text-xs text-muted-foreground mt-1">Using AI to analyze email HTML</div>
            </div>
          ) : result ? (
            <div className="space-y-4">
              {/* Detection Result */}
              <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Status:</span>
                  {result.hasSignature ? (
                    <span className="text-green-600 dark:text-green-400">Signature Found</span>
                  ) : (
                    <span className="text-yellow-600 dark:text-yellow-400">No Signature Detected</span>
                  )}
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Sender:</span> {email.fromAddress}
                </div>
                <div className="text-sm">
                  <span className="text-muted-foreground">Confidence:</span>{' '}
                  <span className={
                    result.confidence === 'high' ? 'text-green-600' :
                    result.confidence === 'medium' ? 'text-yellow-600' : 'text-red-600'
                  }>
                    {result.confidence}
                  </span>
                </div>
                {result.fromCache && (
                  <div className="text-sm text-blue-600 dark:text-blue-400">
                    (Loaded from cache)
                  </div>
                )}
              </div>

              {/* Selector Info */}
              {result.htmlSelector && (
                <div>
                  <div className="text-sm font-medium text-muted-foreground mb-2">CSS Selector:</div>
                  <pre className="bg-muted/50 rounded-lg p-3 text-sm font-mono overflow-x-auto">
                    {result.htmlSelector}
                  </pre>
                </div>
              )}

              {/* Signature Preview */}
              {result.signatureText && (
                <div>
                  <div className="text-sm font-medium text-muted-foreground mb-2">Signature Text:</div>
                  <div className="bg-muted/50 rounded-lg p-3 text-sm whitespace-pre-wrap max-h-[150px] overflow-y-auto">
                    {result.signatureText}
                  </div>
                </div>
              )}

              {/* HTML Sample */}
              {result.sampleHtml && (
                <div>
                  <div className="text-sm font-medium text-muted-foreground mb-2">HTML Sample:</div>
                  <pre className="bg-muted/50 rounded-lg p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-[150px] overflow-y-auto">
                    {result.sampleHtml.substring(0, 500)}
                    {result.sampleHtml.length > 500 && '...'}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              No detection result available
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          {result?.hasSignature && result?.htmlSelector && !result.fromCache && (
            <button
              onClick={onSave}
              className="px-4 py-2 text-sm bg-green-600 text-white hover:bg-green-700 rounded-md transition-colors"
            >
              Save Selector
            </button>
          )}
          {result?.fromCache && (
            <span className="text-sm text-muted-foreground mr-auto">
              Already saved in cache
            </span>
          )}
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-md transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
