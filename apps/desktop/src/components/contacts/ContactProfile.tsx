import { Building, Globe, MapPin, Phone, User } from 'lucide-react';

import { contactProfileCoverage, contactProfileGroups, type ContactProfileSource } from './contact-profile';

export function ContactProfile({ contact, onSearchMail }: {
  contact: ContactProfileSource & { enrichedThroughEmailAt?: number | null };
  onSearchMail?: (query: string) => void;
}) {
  const coverage = contactProfileCoverage(contact);
  const icons = [User, Building, Phone, Globe, MapPin];
  return (
    <section aria-labelledby="contact-profile-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="contact-profile-heading" className="text-base font-semibold">Contact profile</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Saved details and information found in this sender’s email signatures.
          </p>
        </div>
        <div className="text-xs text-muted-foreground text-right">
          <div>{coverage.completed} of {coverage.total} profile areas available</div>
          {contact.enrichedThroughEmailAt ? (
            <div className="mt-1">Emails reviewed through {new Date(contact.enrichedThroughEmailAt * 1000).toLocaleDateString()}</div>
          ) : <div className="mt-1">Waiting for signature analysis</div>}
        </div>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {contactProfileGroups(contact).map((group, index) => {
          const Icon = icons[index]!;
          return (
            <section key={group.label} aria-label={group.label} className="rounded-xl border border-border bg-card p-4">
              <h4 className="flex items-center gap-2 text-sm font-medium mb-3"><Icon className="h-4 w-4 text-primary" />{group.label}</h4>
              <dl className="space-y-2.5">
                {group.fields.map((field) => (
                  <div key={field.label} className="grid grid-cols-[minmax(90px,0.4fr)_minmax(0,1fr)] gap-3 text-sm">
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd className="min-w-0 break-words">
                      {field.label === 'Email' && onSearchMail ? <button type="button" onClick={() => onSearchMail(contact.email)} className="text-primary hover:underline text-left">{field.value}</button>
                        : field.href ? <a href={field.href} target={field.href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className="text-primary hover:underline">{field.value}</a>
                        : field.value || <span className="text-muted-foreground/70">Not found yet</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
      {contact.enrichment?.notes && <p className="text-xs text-muted-foreground">{contact.enrichment.notes}</p>}
    </section>
  );
}
