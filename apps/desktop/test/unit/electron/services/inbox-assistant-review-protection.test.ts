import { describe, expect, it } from 'vitest';

import { unreadReviewContentProtections, unreadReviewRecommendationProtection } from '../../../../electron/services/inbox-assistant-review-protection';

const protections = (subject: string, body = '', fromAddress = 'reports@example.test') => unreadReviewContentProtections({ subject, fromAddress }, body);

describe('unread review content protection', () => {
  it.each([
    ['Screener.in - Watchlist updates', 'Companies in your watchlist: Example Ltd.'],
    ['Investment portfolio update', ''],
    ['Credit card statement for September', ''],
    ['Bank transaction alert', ''],
    ['UPI transaction successful', ''],
    ['Account balance update', ''],
    ['Dividend announced', ''],
    ['Corporate action notification', ''],
    ['Stock price alert', ''],
    ['Card spend limit changed', ''],
    ['Quarterly results for Example Ltd', ''],
    ['Financial report for September', ''],
    ['Credit card bill generated', ''],
    ['Update', 'Your credit card statement is attached.'],
    ['Notification', 'INR 50,000 has been debited from your account.'],
    ['Notification', 'Available balance: 120,000.00'],
    ['Forwarded notification', '> Amount due: INR 4200\n> Please review your statement.'],
  ])('protects financial content: %s', (subject, body) => {
    expect(protections(subject, body)).toContain('Financial notifications, statements or investment reports require your review.');
  });

  it.each([
    ['Zoho SalesIQ: Daily report for Oct 13', '', 'notifications@mailer.zoho.com'],
    ['Zoho SalesIQ: Weekly Report for Oct 12 - Oct 18 2026', '', 'reports@example.test'],
    ['Daily report for Oct 24', 'Visitor Count: 12\nChat Summary: 3\nLead data for your website', 'robot@new-reports.test'],
    ['Weekly Report for Example: Oct 10 - Oct 17', 'TOTAL ISSUES 25\nPerformance summary of your service', 'robot@new-reports.test'],
    ['Customer support summary', 'There are no unresolved tickets.', 'robot@new-reports.test'],
    ['Website analytics report is ready', '', 'reports@new-reports.test'],
    ['Report: Summary of customer calls', '', 'reports@new-reports.test'],
    ['Daily report', '', 'notifications@reports.hubspot.com'],
    ['Site Audit crawl failed', '', 'reports@new-reports.test'],
    ['Cloud service outage detected', '', 'reports@new-reports.test'],
    ['Deployment processing complete', '', 'reports@new-reports.test'],
    ['Server backup completed', '', 'reports@new-reports.test'],
    ['Weekly uptime digest', '', 'reports@new-reports.test'],
    ['Monthly performance summary', '', 'reports@new-reports.test'],
    ['Daily business summary', '', 'reports@new-reports.test'],
    ['Backup failed', '', 'reports@new-reports.test'],
    ['App Store Connect: Version 1.44 (7) for Sarv Workspace has completed processing.', '', 'notification@new-builds.test'],
    ['Version 2.0 finished processing', '', 'notification@new-builds.test'],
    ['Application upload processing failed', '', 'notification@new-builds.test'],
    ['Build failed', '', 'notification@new-builds.test'],
    ['(Sarv) Slow server response for AI crawlers: 4 URLs', '', 'monitor@new-crawler.test'],
    ['(Deepcall) Slow page: 277 URLs', '', 'monitor@new-crawler.test'],
    ['High latency: 1,250 requests affected', '', 'monitor@new-monitor.test'],
    ['Slow database queries: 20 queries', '', 'monitor@new-monitor.test'],
  ])('protects business and operational reports: %s', (subject, body, sender) => {
    expect(protections(subject, body, sender)).toContain('Business reports or operational notifications require your review.');
  });

  it.each([
    ['Download our latest industry report', 'Discover how to grow your business.'],
    ['Special offer on business reporting software', 'Our website analytics product is 50% off.'],
    ['Weekly newsletter: report on global marketing trends', 'Learn about website visitors and customer support.'],
    ['Your weekly newsletter', 'Example Bank | Financial services | Privacy | Report abuse'],
    ['Business insights for ambitious teams', 'Read our latest report today.'],
    ['Weekly report', 'Try our products.'],
    ['Daily report', ''],
    ['Product update', 'Visit our bank partner for deals.'],
    ['New ways to work', 'Privacy policy | Analytics | Report abuse'],
    ['Credit card offers this week', 'Get rewards on your shopping.'],
    ['Our statement on the AI industry', 'We are building the future of AI.'],
    ['Speed up slow pages', 'Our new performance tool makes your website faster.'],
    ['Get a free report on slow server responses', 'Learn about our monitoring product.'],
    ['New version available', 'Try our latest product release.'],
  ])('leaves generic promotions eligible for AI rather than assuming a report: %s', (subject, body) => {
    expect(protections(subject, body)).toEqual([]);
  });

  it.each(['notifications@zoho.com.attacker.test', 'zoho.com@attacker.test', 'notifications@notzoho.com', 'zoho.com'])('does not trust a spoofed reporting domain: %s', sender => {
    expect(protections('Daily report', '', sender)).toEqual([]);
  });

  it('never protects solely because of a reporting sender', () => {
    expect(protections('Special offer', '', 'notifications@zoho.com')).toEqual([]);
  });

  it('keeps financial and business reasons independently when both apply', () => {
    expect(protections('Monthly sales report', 'Available balance: INR 300')).toHaveLength(2);
  });

  it.each([
    ['Exclusive executive invitation', 'An invitation-only evening. Confirm attendance. RSVP By 26 October 2026'],
    ['An evening for executives', 'BY INVITATION ONLY. RSVP before Friday.'],
    ["You've Been Shortlisted For A Leadership Award", 'Your profile has been shortlisted as a potential nominee. We would be pleased to discuss the recognition process. Book a meeting.'],
    ['Leadership recognition', 'You have been shortlisted as a potential nominee for the awards. Discuss the nomination and eligibility process.'],
    ['Partnership for your business', 'Our sponsorship opportunities can support your regional business objectives. Are you available for a quick chat this week?'],
    ['Meet industry leaders', 'Sponsorship opportunities can support Example’s regional business objectives. We can discuss this on a quick chat.'],
    ['Planning an enterprise platform implementation at Example?', 'Does Example still rely on manual reporting across finance and sales? We help with ERP & CRM implementation.'],
    ['Considering a CRM migration?', 'We connect legacy systems. If it makes sense to talk, I am happy to work to your schedule.'],
    ['Evaluating ERP systems for New Company?', 'Do you still rely on disconnected systems? We offer system integration.'],
    ['Re: Migrating legacy systems?', 'Does Other Company still rely on manual processes? Our system integration team can help.'],
  ])('lets AI distinguish unrequested sales-style invitations using sender history: %s', (subject, body) => {
    expect(protections(subject, body)).toEqual([]);
  });

  it.each([
    ['Your requested nomination', 'Following your nomination, please confirm attendance at the awards discussion.'],
    ['Implementation discussion', 'As we discussed, the migration invitation and schedule are ready.'],
    ['RSVP confirmation', 'Thank you for your registration. Please confirm attendance.'],
  ])('retains genuinely requested personal correspondence: %s', (subject, body) => {
    expect(protections(subject, body)).toContain('Personal invitations, recognition or business discussion requests require your review.');
  });

  it.each([
    ['Invoice payment due', 'Please settle invoice INV-2026-109 by Friday.'],
    ['Your quotation for the requested service', 'Please review the quotation.'],
    ['Payment confirmation', 'Your payment was received.'],
    ['Your cloud platform invoice is ready', 'Please visit the billing portal.'],
    ['Invoice # INV-2026 for cloud software', 'Your billing record is available.'],
    ['Contract renewal', 'Please sign the contract.'],
    ['Legal notice', 'You have been served.'],
    ['Meeting invitation: Infrastructure review', 'Meeting tomorrow.'],
    ['Your verification code', 'Your code is 123456.'],
    ['Your password has been changed', 'If you did not do this, contact support.'],
    ['A message for you', 'Your verification code is 123456'],
    ['Requested proposal', 'Please approve the attached proposal by Friday.'],
    ['Update', 'Your invoice is attached and the amount due is listed.'],
  ])('protects actual records, requests and security events: %s', (subject, body) => {
    expect(protections(subject, body)).toContain('Business, financial, meeting or security content requires your review.');
  });

  it.each([
    ['A seasonal sale', 'Enjoy 50% off. Legal | Payment methods | Password help | Privacy policy.'],
    ['Invoice software offer', 'Discover our invoice processing software and payment services.'],
    ['Contract management webinar', 'Learn how to manage contract templates. Register today.'],
    ['Payment platform newsletter', 'Our platform simplifies payment processing for your business.'],
    ['New services', 'Please review our invoice processing software. Get a free demo.'],
    ['Business proposal', 'We offer ERP services. Would you like a demo?'],
    ['New offer: sales summary platform', 'Explore our marketing product today.'],
    ['Security software offer', 'Our password manager helps your team. Book a demo.'],
  ])('does not treat advertising vocabulary or footers as records: %s', (subject, body) => {
    expect(protections(subject, body)).toEqual([]);
  });

  it.each([
    ['Join our free webinar', 'Register now to learn about AI. Everyone is welcome.'],
    ['Awards nominations are open', 'Nominate yourself for our leadership awards. Check eligibility and book a meeting to learn more.'],
    ['Exclusive invitation', 'Register now for our product launch.'],
    ['Discover event sponsorship opportunities', 'Reach thousands of customers. Buy your sponsorship package today.'],
    ['New product newsletter', 'We can discuss our product. Watch a demo now.'],
    ['Planning an ERP implementation?', 'Join our free webinar about ERP implementation. Register now.'],
    ['Considering a CRM migration?', 'Download our free guide to legacy systems. Book a demo at any time.'],
    ['Systems planning newsletter', 'Does your company still rely on manual reporting? We offer ERP systems.'],
    ['Planning your next holiday?', 'Are you happy to work to your schedule?'],
  ])('keeps general webinar, award and event advertising eligible: %s', (subject, body) => {
    expect(protections(subject, body)).toEqual([]);
  });
});

describe('unread review explanation contradiction protection', () => {
  it.each([
    'Automated daily summary report.',
    'Automated weekly report with business metrics.',
    'A monthly performance report.',
    'Business report describing website visitors.',
    'Sales summary sent automatically.',
    'Analytics report from an automated service.',
    'A report of website visitors for your business.',
    'Operational report with no requested action.',
    'Routine account notification.',
    'Automated system status notification.',
    'Service notification with routine status information.',
    'Financial email about market performance.',
    'Investment newsletter without a direct request.',
    'An automated watchlist update.',
    'Credit card statement with no action required.',
    'Targeted invitation with a requested RSVP.',
    'Award nomination with a requested discussion.',
  ])('vetoes mark-read when the explanation identifies protected content: %s', reason => {
    expect(unreadReviewRecommendationProtection(reason)).toBeDefined();
  });

  it.each([
    'Promotional email for reporting software.',
    'Marketing offer for a reporting platform.',
    'Download a free industry report.',
    'Promotional discount for a tool that generates weekly reports using reporting software.',
    'Generic newsletter with no business relevance.',
    'Marketing email without relevant financial content.',
    'The message lacks important investment information.',
    'A general promotion, with no account notifications.',
    'Unsolicited marketing offer without a personal request.',
    'Unsolicited award nomination marketing pitch.',
    'Promotional invitation-only event with a sales RSVP.',
  ])('does not convert generic advertising or explicit negative claims into source facts: %s', reason => {
    expect(unreadReviewRecommendationProtection(reason)).toBeUndefined();
  });
});
