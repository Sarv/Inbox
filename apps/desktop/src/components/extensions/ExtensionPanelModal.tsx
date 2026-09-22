import type { AvailablePanel } from '@sarvinbox/core';
import { X } from 'lucide-react';
import { useEffect } from 'react';


import { Tooltip } from '../Tooltip';

import { ExtensionPanelFrame } from './ExtensionPanelFrame';

/**
 * An extension panel shown as a dialog.
 *
 * Same frame, same bridge, same permission checks as the sidebar — only the
 * surface differs. The header names the extension for the same reason it does
 * in the sidebar: nothing an extension draws should be mistakable for the app's
 * own UI.
 */

interface ExtensionPanelModalProps {
  available: AvailablePanel;
  currentMessageId?: string;
  onClose: () => void;
}

export function ExtensionPanelModal({
  available,
  currentMessageId,
  onClose,
}: ExtensionPanelModalProps) {
  // Escape closes it from the app side. A sandboxed panel cannot install a
  // handler on this window, so the reader is never stuck inside a panel.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${available.panel.title}, from ${available.extensionName}`}
    >
      <div className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-2xl h-[70vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 h-11 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate">{available.panel.title}</h2>
            <p className="text-[11px] text-muted-foreground truncate">
              From {available.extensionName}
            </p>
          </div>
          <Tooltip content="Close" delayMs={40}>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 shrink-0"
            >
              <X className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        <div className="flex-1 min-h-0">
          <ExtensionPanelFrame
            available={available}
            currentMessageId={currentMessageId}
            onRequestClose={onClose}
          />
        </div>
      </div>
    </div>
  );
}
