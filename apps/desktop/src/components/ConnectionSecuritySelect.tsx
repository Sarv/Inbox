import type { ConnectionSecurity } from '@sarvinbox/core/connection-security';

import { defaultPort } from '../config/email-providers';

/**
 * The "Connection security" picker for an account's incoming (IMAP) or sending
 * (SMTP) server — one control so every account form offers the same three
 * choices with the same meaning (CASA M-5, see resolveConnectionSecurity):
 * STARTTLS REQUIRES encryption; only None lets the session continue without it,
 * and it says so.
 */
export function ConnectionSecuritySelect({
  server,
  value,
  onChange,
  className,
  disabled,
}: {
  server: 'imap' | 'smtp';
  value: ConnectionSecurity;
  /** Called with the new security and its default port for this server. */
  onChange: (security: ConnectionSecurity, port: number) => void;
  className?: string;
  disabled?: boolean;
}) {
  const label = server === 'imap' ? 'Incoming connection security' : 'Sending connection security';
  return (
    <div>
      <label className="block text-sm font-medium mb-1">Connection security</label>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const security = event.target.value as ConnectionSecurity;
          onChange(security, defaultPort(server, security));
        }}
        className={className}
      >
        <option value="ssl">SSL/TLS (port {defaultPort(server, 'ssl')})</option>
        <option value="starttls">STARTTLS (port {defaultPort(server, 'starttls')})</option>
        <option value="none">None (not recommended)</option>
      </select>
      {value === 'none' && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          Your password and mail are sent unencrypted unless the server offers encryption. Choose this only for a server
          that has none, on a network you trust.
        </p>
      )}
    </div>
  );
}
