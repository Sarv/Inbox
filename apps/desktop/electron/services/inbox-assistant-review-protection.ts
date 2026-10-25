import type { EmailRecord } from '@sarvinbox/core';

const FINANCIAL_REASON = 'Financial notifications, statements or investment reports require your review.';
const BUSINESS_REASON = 'Business reports or operational notifications require your review.';
const PERSONAL_REASON = 'Personal invitations, recognition or business discussion requests require your review.';

// A sender is supporting evidence only. Unknown providers can qualify through
// the subject and report contents; an address containing one of these strings
// is not a match (for example, zoho.com.attacker.test).
const REPORTING_DOMAINS = ['zoho.com', 'zohosalesiq.com', 'salesforce.com', 'hubspot.com', 'intercom.io', 'zendesk.com', 'freshdesk.com', 'semrush.com', 'ahrefs.com', 'sentry.io', 'analytics.google.com', 'googleanalytics.com', 'matomo.cloud'];
const PERIODIC = /\b(?:daily|weekly|monthly|quarterly|annual|yearly|day|week|month|quarter|year)\b/iu;
const REPORT = /\b(?:reports?|summar(?:y|ies)|digest|statistics|metrics|insights)\b/iu;
const BUSINESS_CONTEXT = /\b(?:sales(?:iq)?|leads?|visitors?|customers?|help\s?desk|tickets?|website|web\s?site|traffic|analytics|conversion|revenue|billing|inventory|support|operations?|operational|service|system|cloud|server|database|backup|deployment|uptime|audit|seo|calls?|pipeline|performance)\b/iu;
const METRIC_VALUE = /\b(?:total\s+)?(?:visitors?|chats?|leads?|customers?|sessions?|page\s?views?|conversions?|tickets?|issues?|errors?|calls?|revenue|sales|uptime|response\s+time)\s*(?:count|summary|received|resolved|opened|closed|generated|duration|rate)?\s*[:=|–—-]?\s*(?:[₹$€£]\s*)?\d/iu;
const MARKETING_REPORT = /\b(?:download|buy|purchase|order|claim|get|discover|explore|learn|unlock)\b.{0,65}\b(?:free|our|industry|market|research|latest|exclusive|sample)\b.{0,50}\b(?:report|white\s?paper|e-?book)\b|\b(?:webinar|newsletter|special\s+offer|reporting\s+software|industry\s+trends)\b/iu;

function reportingSender(address: string): boolean {
  const domain = address.trim().toLowerCase().split('@').at(-1) ?? '';
  return address.includes('@') && REPORTING_DOMAINS.some(allowed => domain === allowed || domain.endsWith(`.${allowed}`));
}

function financialContent(subject: string, body: string): boolean {
  // These subjects denote financial records or subscribed investment updates,
  // rather than the generic words "business", "bank" or "report" in a footer.
  if (/\b(?:watch\s?list|portfolio|holdings?|dividends?|corporate\s+actions?|stock\s+split|(?:earnings|financial|quarterly)\s+(?:results?|updates?|reports?|summar(?:y|ies))|(?:bank|credit\s+card|debit\s+card|loan|demat|trading|account)\s+(?:e-?)?statements?|(?:credit|debit)\s+card\s+bills?|(?:bank|card|upi)\s+(?:transactions?|alerts?)|transaction\s+(?:alerts?|details|confirmation|successful)|(?:credit|debit|spend)\s+limit|(?:account|card|loan)\s+(?:balance|dues?|repayment)|(?:stocks?|shares?|investments?)\s+(?:price|updates?|results?|summary|alerts?|report))\b/iu.test(subject)) return true;
  // Inspect complete original bodies, including quotations, but require an
  // actual financial event/record. A linked "financial services" footer alone
  // must not protect every otherwise disposable newsletter.
  return body.split(/\r?\n/u).some(line =>
    /\b(?:your\s+)?(?:bank|credit\s+card|debit\s+card|loan|demat|trading)\s+(?:e-?)?statement\b/iu.test(line)
    || /\b(?:debited|credited|withdrawn|spent|transferred|transaction\s+(?:amount|id|reference)|available\s+balance|outstanding\s+(?:balance|amount)|amount\s+due|interest\s+(?:earned|charged))\b.{0,100}(?:\d|[₹$€£])/iu.test(line)
    || /(?:[₹$€£]|\b(?:INR|USD|EUR|GBP|Rs\.?))\s*[\d,.]+.{0,65}\b(?:debited|credited|withdrawn|spent|transferred|due|balance)\b/iu.test(line)
    || /\b(?:portfolio|holdings?|watch\s?list)\b.{0,80}\b(?:stocks?|shares?|investments?|returns?|prices?|earnings|dividends?)\b/iu.test(line));
}

/** Deterministic keep-unread gates run on complete originals before AI/cache. */
export function unreadReviewContentProtections(email: Pick<EmailRecord, 'subject' | 'fromAddress'>, body: string): string[] {
  const subject = email.subject ?? '';
  const reasons: string[] = [];
  if (financialContent(subject, body)) reasons.push(FINANCIAL_REASON);

  const subjectReport = REPORT.test(subject);
  const actualMetrics = METRIC_VALUE.test(body);
  const promotional = MARKETING_REPORT.test(subject);
  const businessReport = subjectReport && !promotional && (
    BUSINESS_CONTEXT.test(subject)
    || (PERIODIC.test(subject) && (actualMetrics || /\bbusiness\b/iu.test(subject) || reportingSender(email.fromAddress)))
    || (actualMetrics && BUSINESS_CONTEXT.test(body))
  );
  const operationalNotice = BUSINESS_CONTEXT.test(subject)
    && /\b(?:failed|failure|errors?|outage|incident|downtime|degraded|unavailable|interrupted|threshold\s+exceeded|quota\s+exceeded|action\s+required|processing\s+(?:complete|completed|failed)|(?:job|backup|deployment|crawl)\s+(?:complete|completed|failed))\b/iu.test(subject);
  // Build/release processing notices and measured crawl diagnostics are useful
  // operational records even when they are not called a report. Avoid treating
  // an unmeasured "speed up slow pages" advertisement as a diagnostic.
  const processingNotice = /\b(?:app|application|build|version|release|upload)\b/iu.test(subject)
    && /\b(?:(?:completed|finished)\s+processing|processing\s+(?:complete|completed|finished|failed)|(?:build|release|upload)\s+(?:complete|completed|finished|failed))\b/iu.test(subject);
  const measuredPerformanceIssue = /\b(?:slow\s+(?:(?:server|page|website|site|database|api)\s+)?(?:response|pages?|loading|queries|requests?)|high\s+latency|timeouts?)\b/iu.test(subject)
    && /\b\d[\d,.]*\s*(?:urls?|pages?|ms|milliseconds?|s|seconds?|requests?|queries)\b/iu.test(subject);
  if (businessReport || operationalNotice || processingNotice || measuredPerformanceIssue) reasons.push(BUSINESS_REASON);

  const original = `${subject}\n${body}`;
  const invitationOnly = /\b(?:invitation\s*[-–—]?\s*only|by\s+invitation\s+only)\b/iu.test(original)
    && /\b(?:rsvp\s+(?:by|before|deadline)|confirm\s+(?:(?:your|the)\s+)?attendance)\b/iu.test(original);
  const personalRecognition = /\b(?:awards?|recognition)\b/iu.test(original)
    && /\b(?:you(?:['’]ve|\s+have|\s+are)|your\s+(?:profile|name|nomination))\b.{0,100}\b(?:shortlisted|nominated|nominee)|\byour\s+nomination\b/isu.test(original)
    && /\b(?:discuss|discussion|eligibility|book\s+(?:a\s+)?meeting|schedule\s+(?:a\s+)?(?:call|meeting))\b/iu.test(original);
  const targetedBusinessDiscussion = /\b(?:sponsorship|partnership)\s+opportunities\b/iu.test(original)
    && /\b(?:(?:quick|brief|short)\s+(?:chat|call|discussion)|(?:can|could|would)\s+discuss)\b/iu.test(original)
    && /\b(?:your|[\p{L}\d&.-]+['’]s)\s+(?:(?:regional|business|commercial|strategic)\s+){0,3}(?:objectives|goals|needs|priorities)\b/iu.test(original);
  const systemsPlanningQuestion = /^\s*(?:re:\s*|fw[d]?:\s*)*(?:planning|evaluating|considering|implementing|migrating|integrating|upgrading)\b[^?]{0,180}\?/iu.test(subject)
    && /\b(?:erp|crm|implementation|migration|integration|systems?|database|data\s+(?:platform|warehouse)|analytics)\b/iu.test(subject)
    && /\b(?:erp|crm|legacy\s+systems?|system\s+integration|manual\s+reporting|disconnected\s+data|spreadsheet[-\s]*heavy)\b/iu.test(body)
    && (
      /\b(?:does|do|is|are|has|have|would|could)\b[^?\n]{0,160}\b(?:manual\s+(?:reporting|work|processes)|disconnected\s+(?:data|systems)|spreadsheet[-\s]*(?:heavy|based|processes)|legacy\s+systems?)\b[^?\n]{0,80}\?/iu.test(body)
      || /\b(?:happy|available|glad)\s+to\s+(?:work|meet|talk|speak)\b[^.!?\n]{0,60}\byour\s+schedule\b/iu.test(body)
    );
  if (invitationOnly || personalRecognition || targetedBusinessDiscussion || systemsPlanningQuestion) reasons.push(PERSONAL_REASON);
  return reasons;
}

/**
 * Veto a contradictory mark-read explanation. This does not establish source
 * facts or authorize any action: only complete originals can do that. If the
 * classifier itself describes protected records, fail toward retaining mail.
 */
export function unreadReviewRecommendationProtection(reason: string): string | undefined {
  const affirmative = reason.replace(/\b(?:no|without|lacks?)\s+(?:(?:any|relevant|important|meaningful|personal|direct|actual|new)\s+)*(?:financial|investment|business|operational|system|account)\s+(?:content|information|relevance|records?|reports?|notifications?|updates?)\b/giu, '');
  if (/\b(?:financial|investment)\s+(?:emails?|reports?|summar(?:y|ies)|updates?|notifications?|statements?|information|content|news(?:letters?)?|advice)|\b(?:watch\s?list|portfolio|holdings?|dividends?|(?:bank|credit\s+card|debit\s+card|loan)\s+statements?|(?:account|card|upi)\s+transactions?)\b/iu.test(affirmative)) return FINANCIAL_REASON;

  const reportAdvertisement = /\b(?:promot(?:es|ing|ional)|advertis(?:es|ing|ement)|marketing|offers?|discount|download|free)\b.{0,100}\b(?:reporting\s+(?:software|tools?|platform)|(?:industry|market|research|sample)\s+reports?)\b/iu.test(affirmative);
  if (!reportAdvertisement && (
    /\b(?:daily|weekly|monthly|quarterly|annual|yearly)\s+(?:(?:automated|business|sales|analytics|performance|operational|summary|email)\s+){0,3}(?:reports?|summar(?:y|ies)|digest)\b/iu.test(affirmative)
    || /\b(?:business|sales|analytics|performance|operational|website|visitors?|customer|support|service|system)\s+(?:(?:summary|activity|performance|daily|weekly|monthly)\s+){0,2}(?:reports?|summar(?:y|ies))\b/iu.test(affirmative)
    || /\b(?:reports?|summar(?:y|ies))\s+(?:(?:of|on|for|about|the|your|website)\s+){1,4}(?:sales|analytics|performance|operations?|visitors?|customers?|support|service|system)\b/iu.test(affirmative)
    || /\b(?:account|system|operational|service)\s+(?:status\s+)?notifications?\b/iu.test(affirmative)
  )) return BUSINESS_REASON;
  if (/\b(?:personal|targeted|invitation[- ]only)\s+(?:awards?\s+)?invitations?|\b(?:award|recognition)\s+(?:nomination|shortlist)|\b(?:personal|your)\s+nomination\b/iu.test(affirmative)) return PERSONAL_REASON;
  return undefined;
}
