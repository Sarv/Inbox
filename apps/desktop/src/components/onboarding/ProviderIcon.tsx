import { Globe, Mail } from 'lucide-react';

const ASSETS: Record<string, string> = {
  sarv: 'sarv.png',
  'sarv-ai': 'sarv-ai.svg',
  gmail: 'gmail.png',
  outlook: 'outlook.svg',
  yahoo: 'yahoo.ico',
  openai: 'openai.svg',
  gemini: 'gemini.png',
};

/** Bundled provider marks: onboarding never contacts a logo CDN. */
export function ProviderIcon({ id, className = 'h-10 w-10' }: { id: string; className?: string }) {
  const asset = ASSETS[id];
  if (asset) return <img src={`/provider-icons/${asset}`} alt="" aria-hidden="true" className={`${className} shrink-0 rounded-lg object-contain`} />;
  const Icon = id === 'other' ? Mail : Globe;
  return <Icon aria-hidden="true" className={`${className} shrink-0 text-muted-foreground`} />;
}
