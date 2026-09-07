import { Loader2, Mail } from 'lucide-react';

import type { CategoryEmailListProps } from './types';

export function CategoryEmailList({
  emails,
  loading,
  categoryName,
  onSelectEmail,
  selectedEmailId,
}: CategoryEmailListProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
        <Mail className="h-12 w-12 mb-4 opacity-50" />
        <p className="text-lg font-medium">No emails in {categoryName}</p>
        <p className="text-sm">Emails matching this category will appear here</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border">
      {emails.map((email) => (
        <div
          key={email.id}
          onClick={() => onSelectEmail(email.id)}
          className={`p-4 cursor-pointer transition-colors ${
            selectedEmailId === email.id
              ? 'bg-accent'
              : 'hover:bg-accent/50'
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold flex-shrink-0">
              {(email.fromName || email.fromAddress).substring(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className={`font-medium truncate ${!(email.tags || '').includes('|read|') ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {email.fromName || email.fromAddress}
                </span>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(email.date * 1000).toLocaleDateString()}
                </span>
              </div>
              <p className={`truncate ${!(email.tags || '').includes('|read|') ? 'font-medium' : ''}`}>
                {email.subject || '(no subject)'}
              </p>
              <p className="text-sm text-muted-foreground truncate">
                {email.cleanBody?.substring(0, 100) || '(no content)'}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
