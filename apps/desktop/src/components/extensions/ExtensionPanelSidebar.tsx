import type { AvailablePanel } from '@sarvinbox/core';
import { PanelRightClose, Puzzle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';


import { Tooltip } from '../Tooltip';

import { ExtensionPanelFrame } from './ExtensionPanelFrame';
import { RegistryImage } from './RegistryImage';

/**
 * The right-hand rail that holds extension panels beside the open message.
 *
 * Beside the message and never inside it. A panel drawn in the message body
 * would be indistinguishable from the message's own content — which is exactly
 * the confusion a phishing mail wants — so extension UI lives in its own column
 * with its own header naming the extension it belongs to.
 *
 * One panel is shown at a time; when several extensions contribute a sidebar
 * panel they appear as tabs. Each panel's iframe stays mounted only while it is
 * the selected one, so a background panel cannot keep asking the host for the
 * open message.
 */

interface ExtensionPanelSidebarProps {
  panels: AvailablePanel[];
  /** Id of the message the reader has open, or undefined when none is. */
  currentMessageId?: string;
  onClose: () => void;
}

/** Clamped so a panel cannot make itself wider than the mail it sits beside. */
const MIN_WIDTH = 260;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 340;

function widthFor(available: AvailablePanel | undefined): number {
  const requested = available?.panel.width;
  if (!requested || !Number.isFinite(requested)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, requested));
}

export function ExtensionPanelSidebar({
  panels,
  currentMessageId,
  onClose,
}: ExtensionPanelSidebarProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const keyed = useMemo(
    () => panels.map((available) => ({
      key: `${available.extensionId}:${available.panel.id}`,
      available,
    })),
    [panels]
  );

  // Fall back to the first panel whenever the selected one goes away — an
  // extension can be disabled while its panel is on screen.
  useEffect(() => {
    if (keyed.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (!selectedKey || !keyed.some((entry) => entry.key === selectedKey)) {
      setSelectedKey(keyed[0].key);
    }
  }, [keyed, selectedKey]);

  const selected = keyed.find((entry) => entry.key === selectedKey);
  if (!selected) return null;

  return (
    <aside
      className="h-full shrink-0 border-l border-border bg-card flex flex-col"
      style={{ width: widthFor(selected.available) }}
      aria-label="Extension panels"
    >
      <div className="flex items-center gap-1 px-2 h-10 border-b border-border shrink-0">
        <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto">
          {keyed.map(({ key, available }) => {
            const isSelected = key === selectedKey;
            return (
              <Tooltip
                key={key}
                content={`${available.panel.title} — ${available.extensionName}`}
                delayMs={40}
              >
                <button
                  type="button"
                  onClick={() => setSelectedKey(key)}
                  aria-label={`${available.panel.title}, from ${available.extensionName}`}
                  aria-current={isSelected ? 'true' : undefined}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs whitespace-nowrap transition-colors ${
                    isSelected
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                  }`}
                >
                  {available.iconUrl ? (
                    <RegistryImage
                      src={available.iconUrl}
                      alt=""
                      aria-hidden="true"
                      className="h-3.5 w-3.5"
                    />
                  ) : (
                    <Puzzle className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {available.panel.title}
                </button>
              </Tooltip>
            );
          })}
        </div>

        <Tooltip content="Hide panels" delayMs={40}>
          <button
            type="button"
            onClick={onClose}
            aria-label="Hide panels"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/60 shrink-0"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      {/* Names the extension the content below belongs to. Without it a panel
          could pass itself off as part of Sarv Inbox. */}
      <div className="px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border shrink-0 truncate">
        From {selected.available.extensionName}
      </div>

      <div className="flex-1 min-h-0">
        <ExtensionPanelFrame
          // Keyed on the panel, so switching tabs tears the old frame down
          // instead of reusing it under a different extension's identity.
          key={selected.key}
          available={selected.available}
          currentMessageId={currentMessageId}
          onRequestClose={onClose}
        />
      </div>
    </aside>
  );
}
