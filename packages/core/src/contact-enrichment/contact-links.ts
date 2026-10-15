/** Contact links must be destinations, never share buttons, tracking pixels or login pages. */
export function normalizeContactUrl(raw: string): string | null {
  const text = raw.trim().replace(/&amp;/gi, '&').replace(/[\]),.;|]+$/, '');
  if (!text || /\s/.test(text)) return null;
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return null;
  const host = url.hostname.toLowerCase();
  if (host.endsWith('.safelinks.protection.outlook.com')) {
    const destination = url.searchParams.get('url');
    return destination && !destination.includes('safelinks.protection.outlook.com') ? normalizeContactUrl(destination) : null;
  }
  if (/^(?:click|track|tracking|links?|email)\./i.test(host) || /(?:^|\.)(?:urldefense\.com|urldefense\.proofpoint\.com|t\.co|bit\.ly|lnkd\.in)$/.test(host)) return null;
  if (/(?:^|\/)(?:share|sharer(?:\.php)?|shareArticle|intent|unsubscribe|login|signin|oauth|tracking|pixel)(?:\/|$)/i.test(url.pathname)) return null;
  if (/\.(?:gif|png|jpg|jpeg|svg|webp|pdf|docx?|xlsx?|pptx?)$/i.test(url.pathname)) return null;
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

export type ContactLinkKind = 'linkedinPersonal' | 'linkedinCompany' | 'twitter' | 'github' | 'other' | 'website';

export function contactLinkKind(raw: string): ContactLinkKind | null {
  const normalized = normalizeContactUrl(raw);
  if (!normalized) return null;
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');
  if (host === 'linkedin.com' || /^[a-z]{2}\.linkedin\.com$/.test(host)) {
    if (/^\/(?:in|pub)\/[^/]+(?:\/[^/]+)*$/i.test(path)) return 'linkedinPersonal';
    if (/^\/(?:company|school)\/[^/]+$/i.test(path)) return 'linkedinCompany';
    return null;
  }
  if (host === 'x.com' || host === 'twitter.com') return /^\/[a-z0-9_]{1,15}$/i.test(path) && !/^\/(?:home|search|explore|settings|messages|notifications|i)$/i.test(path) ? 'twitter' : null;
  if (host === 'github.com') return /^\/[a-z0-9-]+$/i.test(path) && !/^\/(?:login|signup|orgs|marketplace|features|topics|explore|settings)$/i.test(path) ? 'github' : null;
  if (['facebook.com', 'instagram.com', 'threads.net', 'threads.com', 'medium.com', 'mastodon.social'].includes(host)) {
    return path && !/^\/(?:p|reel|reels|watch|stories|groups|events|posts|explore)(?:\/|$)/i.test(path) ? 'other' : null;
  }
  if (host === 'youtube.com') return /^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)$/i.test(path) ? 'other' : null;
  if (host === 'youtu.be') return null;
  if (host === 'bsky.app') return /^\/profile\/[^/]+$/i.test(path) ? 'other' : null;
  if (host === 'wa.me') return /^\/\d{8,15}$/.test(path) ? 'other' : null;
  return 'website';
}
