/**
 * Reply Style Analyzer
 *
 * Learns the user's writing style from their sent emails.
 * Extracts tone, formality, length patterns, and common phrases
 * to generate replies that match the user's voice.
 */

import type { ILLMProvider, CompletionOptions } from '../types/llm';
import type { EmailRecord } from '../types/models';
import { parseAddresses } from '../utils/email-address';
import { logger } from '../utils/logger';

export interface ReplyStyleProfile {
  /** Average reply length in characters */
  avgReplyLength: number;
  /** Typical greeting patterns (e.g., "Hi {name},", "Hey,") */
  greetingPatterns: string[];
  /** Typical closing patterns (e.g., "Best,", "Thanks,") */
  closingPatterns: string[];
  /** Formality level: 0 = very casual, 1 = very formal */
  formalityScore: number;
  /** Whether user typically uses bullet points / lists */
  usesLists: boolean;
  /** Whether user typically includes a greeting */
  includesGreeting: boolean;
  /** Whether user typically includes a closing */
  includesClosing: boolean;
  /** Sample fingerprints for few-shot prompting */
  sampleReplies: Array<{
    inReplyTo: string; // Subject of email being replied to
    body: string;      // User's actual reply (cleaned)
    senderDomain: string;
    tone: 'formal' | 'casual' | 'brief';
  }>;
  /** How many sent emails were analyzed */
  analyzedCount: number;
  lastUpdated: number;
}

export class ReplyStyleAnalyzer {
  private cachedProfile: ReplyStyleProfile | null = null;

  constructor() {}

  /**
   * Analyze a set of sent emails to build a reply style profile
   */
  async analyzeStyle(sentEmails: EmailRecord[]): Promise<ReplyStyleProfile> {
    if (sentEmails.length === 0) {
      return this.emptyProfile();
    }

    // Filter to actual replies (has inReplyTo)
    const replies = sentEmails.filter(e => e.inReplyTo);
    const sample = replies.length > 0 ? replies : sentEmails;

    // Extract body text
    const bodies = sample
      .map(e => this.cleanReplyBody(e.cleanBody || e.rawBody || ''))
      .filter(b => b.length > 10 && b.length < 5000);

    if (bodies.length === 0) return this.emptyProfile();

    // Statistical analysis
    const avgLength = Math.round(bodies.reduce((sum, b) => sum + b.length, 0) / bodies.length);
    const greetings = this.extractGreetings(bodies);
    const closings = this.extractClosings(bodies);
    const formality = this.estimateFormality(bodies);
    const usesLists = bodies.some(b => /^\s*[-•*]\s/m.test(b) || /^\s*\d+\.\s/m.test(b));

    // Build sample replies for few-shot prompting
    const sampleReplies = sample.slice(0, 10).map(email => {
      const body = this.cleanReplyBody(email.cleanBody || email.rawBody || '');
      const domain = (parseAddresses(email.toAddress)[0] || '').split('@')[1] || 'unknown';
      return {
        inReplyTo: email.subject || 'Unknown',
        body: body.substring(0, 500),
        senderDomain: domain,
        tone: this.classifyTone(body),
      };
    });

    const profile: ReplyStyleProfile = {
      avgReplyLength: avgLength,
      greetingPatterns: greetings,
      closingPatterns: closings,
      formalityScore: formality,
      usesLists,
      includesGreeting: greetings.length > 0,
      includesClosing: closings.length > 0,
      sampleReplies,
      analyzedCount: bodies.length,
      lastUpdated: Math.floor(Date.now() / 1000),
    };

    this.cachedProfile = profile;
    return profile;
  }

  /**
   * Generate a reply draft based on learned style
   */
  async generateReply(
    incomingEmail: EmailRecord,
    threadHistory: EmailRecord[],
    profile: ReplyStyleProfile,
    llm: ILLMProvider,
  ): Promise<{ subject: string; body: string; confidence: number }> {
    // Build few-shot examples from profile
    const examples = profile.sampleReplies.slice(0, 3).map(s =>
      `Subject: ${s.inReplyTo}\nReply: ${s.body}`
    ).join('\n\n---\n\n');

    const styleGuide = this.buildStyleGuide(profile);

    const systemPrompt = `You are drafting an email reply on behalf of the user. Match their writing style exactly.

${styleGuide}

Here are examples of how the user typically writes replies:

${examples || 'No examples available — use a professional, concise tone.'}

IMPORTANT:
- Match the user's typical reply length (~${profile.avgReplyLength} characters)
- Use their greeting/closing style
- Match their formality level
- Do NOT add signatures or contact info
- Return ONLY the reply body text, no metadata`;

    const threadContext = threadHistory.slice(-3).map(e =>
      `From: ${e.fromName || e.fromAddress}\nDate: ${new Date(e.date * 1000).toISOString()}\n${(e.cleanBody || '').substring(0, 300)}`
    ).join('\n\n---\n\n');

    const userPrompt = `Thread context:
${threadContext}

Latest email to reply to:
From: ${incomingEmail.fromName || incomingEmail.fromAddress}
Subject: ${incomingEmail.subject}
Body:
${(incomingEmail.cleanBody || '').substring(0, 1500)}

Draft a reply in the user's style:`;

    const options: CompletionOptions = {
      temperature: 0.7,
      maxTokens: 500,
    };

    try {
      const body = await llm.generateChatCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], options);
      const subject = incomingEmail.subject?.startsWith('Re:')
        ? incomingEmail.subject
        : `Re: ${incomingEmail.subject || ''}`;

      // Confidence based on profile quality
      const confidence = Math.min(0.9, profile.analyzedCount / 50);

      return { subject, body, confidence: Math.round(confidence * 100) / 100 };
    } catch (error) {
      logger.error('Failed to generate reply:', error);
      throw error;
    }
  }

  /**
   * Get cached profile
   */
  getProfile(): ReplyStyleProfile | null {
    return this.cachedProfile;
  }

  // ========== Private Helpers ==========

  private cleanReplyBody(body: string): string {
    let s = body
      .replace(/<[^>]+>/g, '') // Strip HTML
      .replace(/^>.*$/gm, '') // Strip quoted text
      .replace(/^On .+ wrote:$/gm, ''); // Strip "On ... wrote:"

    // Strip signature: only a line consisting solely of 2-3 dashes is a
    // delimiter, and use the LAST one — markdown rules / "--" mid-email
    // must not truncate the body.
    const lines = s.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^-{2,3}\s*$/.test(lines[i])) {
        s = lines.slice(0, i).join('\n');
        break;
      }
    }

    return s
      .replace(/\n{3,}/g, '\n\n') // Normalize whitespace
      .trim();
  }

  private extractGreetings(bodies: string[]): string[] {
    const greetings = new Map<string, number>();
    const patterns = [
      /^(Hi|Hey|Hello|Dear|Good morning|Good afternoon|Good evening)[,\s!]*/im,
    ];

    for (const body of bodies) {
      const firstLine = body.split('\n')[0]?.trim();
      if (!firstLine) continue;

      for (const pattern of patterns) {
        const match = firstLine.match(pattern);
        if (match) {
          const greeting = firstLine.substring(0, Math.min(firstLine.length, 30));
          greetings.set(greeting, (greetings.get(greeting) || 0) + 1);
        }
      }
    }

    return [...greetings.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([g]) => g);
  }

  private extractClosings(bodies: string[]): string[] {
    const closings = new Map<string, number>();
    const patterns = [
      /(Best|Thanks|Regards|Cheers|Sincerely|Thank you|Kind regards|Best regards|Warm regards)[,\s!]*/i,
    ];

    for (const body of bodies) {
      const lines = body.split('\n').filter(l => l.trim());
      const lastLines = lines.slice(-3);

      for (const line of lastLines) {
        for (const pattern of patterns) {
          const match = line.trim().match(pattern);
          if (match) {
            closings.set(line.trim(), (closings.get(line.trim()) || 0) + 1);
          }
        }
      }
    }

    return [...closings.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([c]) => c);
  }

  private estimateFormality(bodies: string[]): number {
    let formalCount = 0;
    let casualCount = 0;

    for (const body of bodies) {
      const lower = body.toLowerCase();

      // Formal indicators
      if (/dear\s/i.test(lower)) formalCount += 2;
      if (/sincerely|regards/i.test(lower)) formalCount += 1;
      if (/please\s|kindly\s/i.test(lower)) formalCount += 1;
      if (/would you|could you/i.test(lower)) formalCount += 1;

      // Casual indicators (word boundaries — "they" / "delhi" must not match)
      if (/\b(hey|hi|yo)\b/i.test(lower)) casualCount += 1;
      if (/!/g.test(body)) casualCount += 0.5;
      if (/lol|haha|:[)(]/i.test(lower)) casualCount += 2;
      if (/gonna|wanna|gotta/i.test(lower)) casualCount += 1;
      if (/thanks!|cheers/i.test(lower)) casualCount += 0.5;
    }

    const total = formalCount + casualCount;
    if (total === 0) return 0.5;
    return Math.round((formalCount / total) * 100) / 100;
  }

  private classifyTone(body: string): 'formal' | 'casual' | 'brief' {
    if (body.length < 100) return 'brief';
    const formality = this.estimateFormality([body]);
    return formality > 0.5 ? 'formal' : 'casual';
  }

  private buildStyleGuide(profile: ReplyStyleProfile): string {
    const lines: string[] = ['## User Writing Style Guide'];

    lines.push(`- Average reply length: ~${profile.avgReplyLength} characters`);
    lines.push(`- Formality: ${profile.formalityScore > 0.6 ? 'Formal' : profile.formalityScore > 0.3 ? 'Balanced' : 'Casual'}`);

    if (profile.includesGreeting) {
      lines.push(`- Typical greetings: ${profile.greetingPatterns.join(', ')}`);
    } else {
      lines.push('- Usually skips greetings (gets straight to the point)');
    }

    if (profile.includesClosing) {
      lines.push(`- Typical closings: ${profile.closingPatterns.join(', ')}`);
    } else {
      lines.push('- Usually skips formal closings');
    }

    if (profile.usesLists) {
      lines.push('- Often uses bullet points or numbered lists');
    }

    return lines.join('\n');
  }

  private emptyProfile(): ReplyStyleProfile {
    return {
      avgReplyLength: 200,
      greetingPatterns: [],
      closingPatterns: [],
      formalityScore: 0.5,
      usesLists: false,
      includesGreeting: true,
      includesClosing: true,
      sampleReplies: [],
      analyzedCount: 0,
      lastUpdated: Math.floor(Date.now() / 1000),
    };
  }
}
