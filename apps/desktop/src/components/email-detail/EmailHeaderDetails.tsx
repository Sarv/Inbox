import { format } from 'date-fns';
import { ChevronUp, ChevronDown } from 'lucide-react';

import { parseAddresses } from '../../utils/email-address';

interface EmailHeaderDetailsProps {
  email: any;
  showDetails: boolean;
  onToggleDetails: () => void;
}

/**
 * The "to X, +N more · Show details" summary line plus the expandable
 * From/To/Cc/Bcc/Date/Subject block. Shared by the main email (EmailCard) and
 * every thread reply (ThreadList) so both render an identical full header.
 */
export function EmailHeaderDetails({ email, showDetails, onToggleDetails }: EmailHeaderDetailsProps) {
  const recipients = parseAddresses(email.toAddress);

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className="text-sm text-muted-foreground">
        <span>
          to {recipients[0] || '(unknown)'}
          {recipients.length > 1 && <span>, +{recipients.length - 1} more</span>}
        </span>
        <span
          onClick={onToggleDetails}
          className="ml-2 inline-flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer"
        >
          {showDetails ? (
            <>
              <ChevronUp className="h-3 w-3" />
              <span>Hide details</span>
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              <span>Show details</span>
            </>
          )}
        </span>
      </div>

      {showDetails && (
        <div className="mt-3 pt-3 border-t border-border space-y-2 text-sm">
          <div className="grid grid-cols-[80px_1fr] gap-2">
            <span className="text-muted-foreground">From:</span>
            <span className="text-foreground">
              {email.fromName || email.fromAddress}{' '}
              {email.fromName && (
                <span className="text-muted-foreground">&lt;{email.fromAddress}&gt;</span>
              )}
            </span>
          </div>
          <div className="grid grid-cols-[80px_1fr] gap-2">
            <span className="text-muted-foreground">To:</span>
            <span className="text-foreground">{email.toAddress}</span>
          </div>
          {email.ccAddress && (
            <div className="grid grid-cols-[80px_1fr] gap-2">
              <span className="text-muted-foreground">Cc:</span>
              <span className="text-foreground">{email.ccAddress}</span>
            </div>
          )}
          {email.bccAddress && (
            <div className="grid grid-cols-[80px_1fr] gap-2">
              <span className="text-muted-foreground">Bcc:</span>
              <span className="text-foreground">{email.bccAddress}</span>
            </div>
          )}
          <div className="grid grid-cols-[80px_1fr] gap-2">
            <span className="text-muted-foreground">Date:</span>
            <span className="text-foreground">
              {format(new Date(email.date * 1000), "EEEE, MMMM d, yyyy 'at' h:mm a")}
            </span>
          </div>
          <div className="grid grid-cols-[80px_1fr] gap-2">
            <span className="text-muted-foreground">Subject:</span>
            <span className="text-foreground">{email.subject || '(no subject)'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
