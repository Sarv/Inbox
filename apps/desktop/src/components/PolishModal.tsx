import { X, Loader2, Check, RefreshCw, Sparkles } from 'lucide-react';
import { useState, useEffect } from 'react';

import { polishText, getDefaultProvider, PolishContext, PolishResponse } from '../services/ai-service';

import { SandboxedEmailBody } from './SandboxedEmailBody';

interface PolishModalProps {
  originalText: string;
  originalSubject?: string;
  context: PolishContext;
  onAccept: (result: { subject?: string; body: string }) => void;
  onClose: () => void;
}

export function PolishModal({ originalText, originalSubject, context, onAccept, onClose }: PolishModalProps) {
  const [polishedResult, setPolishedResult] = useState<PolishResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showInstructions, setShowInstructions] = useState(false);
  const [instructions, setInstructions] = useState('');

  const provider = getDefaultProvider();
  const isNewEmail = context.mode === 'new' || context.mode === 'forward';
  const isSelectionMode = context.polishMode === 'selection';

  // Initial polish on mount
  useEffect(() => {
    handlePolish();
  }, []);

  const handlePolish = async (customInstructions?: string) => {
    setLoading(true);
    setError('');
    setShowInstructions(false);
    setInstructions('');

    try {
      const result = await polishText(originalText, {
        ...context,
        subject: originalSubject,
      }, customInstructions);
      console.log('[PolishModal] Received result:', result);
      setPolishedResult(result);
    } catch (err) {
      console.error('[PolishModal] Error:', err);
      setError((err as Error).message || 'Failed to polish text');
    } finally {
      setLoading(false);
    }
  };

  const handleImprove = () => {
    setShowInstructions(true);
  };

  const handleSubmitImprove = () => {
    handlePolish(instructions || undefined);
  };

  const handleAccept = () => {
    if (polishedResult) {
      onAccept({
        subject: isSelectionMode ? undefined : polishedResult.subject,
        body: polishedResult.body,
      });
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100]">
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col m-4">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <h2 className="font-semibold">
              {isSelectionMode ? 'Polish Selected Text' : 'Polish with AI'}
            </h2>
            {provider && (
              <span className="text-xs px-2 py-0.5 bg-muted rounded-full text-muted-foreground">
                {provider.name}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-accent rounded-md transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-primary mb-4" />
              <div className="text-muted-foreground">
                {isSelectionMode ? 'Polishing selected text...' : 'Polishing your email...'}
              </div>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12">
              <div className="text-destructive mb-4">{error}</div>
              <button
                onClick={() => handlePolish()}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
              >
                <RefreshCw className="h-4 w-4" />
                Try Again
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Original */}
              <div>
                <div className="text-sm font-medium text-muted-foreground mb-2">
                  {isSelectionMode ? 'Selected Text' : 'Original'}
                </div>
                {!isSelectionMode && isNewEmail && originalSubject && (
                  <div className="text-xs text-muted-foreground mb-1">
                    Subject: {originalSubject}
                  </div>
                )}
                <div className="p-3 bg-muted/50 rounded-lg text-sm whitespace-pre-wrap max-h-32 overflow-y-auto">
                  {isSelectionMode ? context.selectedText : originalText}
                </div>
              </div>

              {/* Polished Result */}
              {polishedResult && (
                <div>
                  <div className="text-sm font-medium text-muted-foreground mb-2 flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-primary" />
                    Polished
                  </div>

                  {/* Polished Subject (only for full mode on new emails) */}
                  {!isSelectionMode && isNewEmail && polishedResult.subject && (
                    <div className="mb-2 p-2 bg-primary/10 border border-primary/20 rounded-lg">
                      <div className="text-xs text-muted-foreground mb-1">Subject:</div>
                      <div className="text-sm font-medium">{polishedResult.subject}</div>
                    </div>
                  )}

                  {/* Polished Body */}
                  {isSelectionMode ? (
                    // Selection mode - plain text display
                    <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg text-sm whitespace-pre-wrap max-h-48 overflow-y-auto">
                      {polishedResult.body}
                    </div>
                  ) : (
                    // Full mode - HTML display
                    <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg text-sm max-h-48 overflow-y-auto">
                      <SandboxedEmailBody html={polishedResult.body} blockRemoteImages={false} />
                    </div>
                  )}
                </div>
              )}

              {/* Improve Instructions */}
              {showInstructions && (
                <div className="space-y-2">
                  <div className="text-sm font-medium text-muted-foreground">
                    Additional instructions (optional)
                  </div>
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder="e.g., Make it more formal, shorter, friendlier..."
                    className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm resize-none"
                    rows={2}
                    autoFocus
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSubmitImprove}
                      className="flex items-center gap-2 px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 text-sm"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Regenerate
                    </button>
                    <button
                      onClick={() => setShowInstructions(false)}
                      className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {!loading && !error && !showInstructions && (
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border bg-muted/30">
            <button
              onClick={handleImprove}
              className="flex items-center gap-2 px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Improve
            </button>
            <button
              onClick={handleAccept}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 text-sm font-medium"
            >
              <Check className="h-4 w-4" />
              {isSelectionMode ? 'Replace' : 'Accept'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
