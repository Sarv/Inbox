import type { AvailablePanel } from '@sarvinbox/core';
import { PanelRight, Puzzle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';


import { useEmailStore } from '../../store/email-store';
import { EmailDetail } from '../email-detail';
import { Tooltip } from '../Tooltip';

import { ExtensionPanelModal } from './ExtensionPanelModal';
import { ExtensionPanelSidebar } from './ExtensionPanelSidebar';
import { RegistryImage } from './RegistryImage';
import { panelsForSurface, useExtensionPanels } from './useExtensionPanels';

/**
 * The open message, with the extension panel rail beside it.
 *
 * Wrapping `EmailDetail` rather than reaching inside it keeps the mail view
 * untouched by extensions: panels get their own column, and the message body
 * stays exactly what the sender sent. An extension drawing inside the body
 * would be indistinguishable from the mail itself.
 *
 * The controls live in a strip of their own rather than floating over the
 * message, so they can never cover the toolbar they sit next to. When no
 * enabled extension was granted `ui:panel` and contributes a panel, this
 * renders `EmailDetail` alone and costs nothing.
 */
export function MailDetailWithPanels() {
  const selectedEmailId = useEmailStore((state) => state.selectedEmailId);
  const { panels } = useExtensionPanels();
  const [dismissed, setDismissed] = useState(false);
  const [modalPanel, setModalPanel] = useState<AvailablePanel | null>(null);

  const sidebarPanels = useMemo(() => panelsForSurface(panels, 'sidebar'), [panels]);
  const modalPanels = useMemo(() => panelsForSurface(panels, 'modal'), [panels]);

  // A panel that asked to open itself gets the rail open on first sight; the
  // reader's choice to hide it wins from then on, for the rest of the session.
  const autoOpen = sidebarPanels.some((available) => available.panel.autoOpen);
  const [open, setOpen] = useState(autoOpen);
  useEffect(() => {
    if (autoOpen && !dismissed) setOpen(true);
  }, [autoOpen, dismissed]);

  // An extension disabled or uninstalled while its panel was on screen must
  // lose the screen with it, not keep a frame open against a dead context.
  useEffect(() => {
    if (modalPanel && !modalPanels.some((available) => isSamePanel(available, modalPanel))) {
      setModalPanel(null);
    }
  }, [modalPanel, modalPanels]);

  // `ctx.ui.openPanel(...)`: an extension asking for one of its OWN panels (the
  // manifest check happened in main). A sidebar panel opens the rail; a modal
  // panel opens the modal. A panel id that matches nothing currently offered is
  // ignored rather than opening something else — the extension may have been
  // disabled between asking and this arriving.
  useEffect(() => {
    const off = window.electronAPI?.extensions?.onOpenPanel?.(({ extensionId, panelId }) => {
      const wanted = panels.find(
        (available) => available.extensionId === extensionId && available.panel.id === panelId
      );
      if (!wanted) return;
      if (wanted.panel.surface === 'modal') {
        setModalPanel(wanted);
      } else {
        setDismissed(false);
        setOpen(true);
      }
    });
    return () => {
      try { off?.(); } catch { /* listener already gone */ }
    };
  }, [panels]);

  const hasPanels = sidebarPanels.length > 0 || modalPanels.length > 0;
  if (!selectedEmailId || !hasPanels) {
    return <EmailDetail />;
  }

  const currentMessageId = selectedEmailId;

  return (
    <div className="flex flex-1 h-full min-w-0 overflow-hidden">
      <EmailDetail />

      {open && sidebarPanels.length > 0 && (
        <ExtensionPanelSidebar
          panels={sidebarPanels}
          currentMessageId={currentMessageId}
          onClose={() => {
            setOpen(false);
            setDismissed(true);
          }}
        />
      )}

      <div className="w-10 shrink-0 flex flex-col items-center gap-1 py-2 border-l border-border bg-card/50">
        {sidebarPanels.length > 0 && (
          <Tooltip content={open ? 'Hide extension panels' : 'Show extension panels'} delayMs={40}>
            <button
              type="button"
              onClick={() => {
                if (open) setDismissed(true);
                setOpen(!open);
              }}
              aria-label={open ? 'Hide extension panels' : 'Show extension panels'}
              aria-pressed={open}
              className={`p-2 rounded-md transition-colors hover:bg-accent ${
                open ? 'text-foreground bg-accent' : 'text-muted-foreground'
              }`}
            >
              <PanelRight className="h-4 w-4" />
            </button>
          </Tooltip>
        )}

        {modalPanels.map((available) => (
          <Tooltip
            key={`${available.extensionId}:${available.panel.id}`}
            content={`${available.panel.title} (${available.extensionName})`}
            delayMs={40}
          >
            <button
              type="button"
              onClick={() => setModalPanel(available)}
              aria-label={`${available.panel.title}, from ${available.extensionName}`}
              className="p-2 rounded-md transition-colors hover:bg-accent text-muted-foreground"
            >
              {available.iconUrl ? (
                <RegistryImage
                  src={available.iconUrl}
                  alt=""
                  aria-hidden="true"
                  className="h-4 w-4"
                />
              ) : (
                <Puzzle className="h-4 w-4" />
              )}
            </button>
          </Tooltip>
        ))}
      </div>

      {modalPanel && (
        <ExtensionPanelModal
          available={modalPanel}
          currentMessageId={currentMessageId}
          onClose={() => setModalPanel(null)}
        />
      )}
    </div>
  );
}

function isSamePanel(left: AvailablePanel, right: AvailablePanel): boolean {
  return left.extensionId === right.extensionId && left.panel.id === right.panel.id;
}
