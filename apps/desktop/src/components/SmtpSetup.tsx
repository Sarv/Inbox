import { Send, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { SmtpConfigForm } from './SmtpConfigForm';

/**
 * Dismissible "Set up sending (SMTP)" modal for the ACTIVE account. Opened via
 * the `sarvinbox:open-smtp-setup` CustomEvent — dispatched from the compose/reply
 * "SMTP not set up" banner (and anywhere else that offers to enable sending).
 *
 * This used to be a full-screen BLOCKING overlay that forced SMTP setup the
 * moment IMAP connected. SMTP is now optional (IMAP-only accounts work and queue
 * to the Outbox), so this is a normal dismissible modal instead. On verify,
 * SmtpConfigForm flips `smtpConfigured` → the banner disappears, SmtpConnector
 * opens the session, and the Outbox drains.
 */
export function SmtpSetup() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const open = () => setIsOpen(true);
    document.addEventListener('sarvinbox:open-smtp-setup', open);
    return () => document.removeEventListener('sarvinbox:open-smtp-setup', open);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" onClick={() => setIsOpen(false)}>
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2 bg-primary/10 rounded-lg">
            <Send className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold">Set up sending</h2>
            <p className="text-sm text-muted-foreground">
              Add your SMTP details to send mail — any queued messages go out once verified.
            </p>
          </div>
          <button type="button" onClick={() => setIsOpen(false)} aria-label="Close" className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <SmtpConfigForm onVerified={() => setIsOpen(false)} submitLabel="Verify & Enable Sending" />
      </div>
    </div>
  );
}
