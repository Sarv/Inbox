import { Loader2, PauseCircle, Sparkles } from 'lucide-react';
import { useSyncExternalStore } from 'react';

import { getEnrichmentStatus, subscribeEnrichmentStatus } from '../../services/contact-enrichment-service';

export function EnrichmentStatus() {
  const status = useSyncExternalStore(subscribeEnrichmentStatus, getEnrichmentStatus);
  const paused = status.pausedReason;
  const Icon = status.running ? Loader2 : paused ? PauseCircle : Sparkles;
  const title = status.running ? 'Updating contacts automatically'
    : paused === 'ai_disabled' ? 'Automatic AI enrichment is paused'
      : paused === 'no_provider' ? 'Add an AI provider to enrich contacts automatically'
        : paused === 'onboarding' ? 'Automatic enrichment starts after setup'
          : 'Automatic signature enrichment';
  return (
    <div role="status" className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 flex items-start gap-3">
      <Icon className={`h-4 w-4 mt-0.5 shrink-0 text-primary ${status.running ? 'animate-spin' : ''}`} />
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {status.running ? `${status.processed} of ${status.total} contacts reviewed in this batch.`
            : paused === 'ai_disabled' ? 'Enable AI Assist in AI → Email Agent. Your saved contact details remain available.'
              : paused === 'no_provider' ? 'Configure a provider in AI → Providers. Signature details are reviewed as email bodies arrive.'
                : 'Names, roles, company details, phone numbers and social links are reviewed from incoming email signatures.'}
        </p>
      </div>
    </div>
  );
}
