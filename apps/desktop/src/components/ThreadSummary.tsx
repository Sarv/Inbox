import type { EmailRecord } from '@sarvinbox/core';
import { Sparkles, ChevronDown, ChevronUp, Loader2, RefreshCw, CheckCircle, Users } from 'lucide-react';
import { useState, useEffect } from 'react';

import { generateThreadSummary as generateThreadSummaryFallback, isThreadSummariesEnabled, getDefaultProvider, getCurrentUserEmail, type ThreadSummary as ThreadSummaryType } from '../services/ai-service';

import { chatMessagesFromThread, toEpochSeconds } from './email-detail/chat-message-adapter';


interface ThreadSummaryProps {
  threadId: string;
  emails: EmailRecord[];
}

export function ThreadSummary({ threadId, emails }: ThreadSummaryProps) {
  const [summary, setSummary] = useState<ThreadSummaryType | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if feature is enabled and provider configured
  const isEnabled = isThreadSummariesEnabled() && getDefaultProvider();

  // Load cached summary on mount
  useEffect(() => {
    if (!threadId || !isEnabled || emails.length < 2) return;

    const loadCachedSummary = async () => {
      try {
        const result = await window.electronAPI.ai.getThreadSummary(threadId);
        if (result.success && result.data) {
          // Check if summary is still valid (email count matches)
          if (result.data.emailCount === emails.length) {
            // Handle both string (from DB) and array (from type) formats
            const parseJsonOrArray = (data: string | string[] | null | undefined): string[] => {
              if (!data) return [];
              if (Array.isArray(data)) return data;
              try { return JSON.parse(data); } catch { return []; }
            };

            setSummary({
              summary: result.data.summary,
              keyPoints: parseJsonOrArray(result.data.keyPoints),
              participants: parseJsonOrArray(result.data.participants),
              confidence: 0.8,
            });
          }
          // Stale or missing cache — don't auto-generate, user will click "Summarize"
        }
      } catch (error) {
        console.error('[ThreadSummary] Failed to load cached summary:', error);
      }
    };

    loadCachedSummary();
  }, [threadId, emails.length]);

  const generateSummary = async () => {
    if (loading || emails.length < 2) return;

    setLoading(true);
    setError(null);

    try {
      // Feed the AI the CLEAN Standard split — the same deterministic
      // per-message bubbles the Standard chat view shows, with quotes,
      // signatures and banners already stripped. This gives the summarizer
      // one clean entry per actual message (including history inlined in a
      // single forwarded email) instead of raw bodies full of quoted noise.
      const currentUserEmail = getCurrentUserEmail(emails[0]?.toAddress || '');
      const splitMessages = chatMessagesFromThread(emails, { currentUserEmail });
      const emailById = new Map(emails.map(e => [e.id, e]));
      const emailsForSummary =
        splitMessages.length > 0
          ? splitMessages.map(message => ({
              id: message.id,
              // A recovered quote has no row of its own, so its subject comes
              // from the mail that carried it (`sourceId`); a real message IS a
              // row, keyed by its own id.
              subject: emailById.get(message.sourceId || message.id)?.subject || emails[0]?.subject || '',
              fromAddress: message.fromAddress || '',
              fromName: message.fromName ?? null,
              toAddress: message.toAddress || '',
              date: toEpochSeconds(message.date),
              body: message.body,
            }))
          : // Fallback: split produced nothing — summarize raw bodies.
            emails.map(email => ({
              id: email.id,
              subject: email.subject || '',
              fromAddress: email.fromAddress || '',
              fromName: email.fromName,
              toAddress: email.toAddress || '',
              date: email.date,
              body: email.cleanBody || email.rawBody || '',
            }));

      let result: ThreadSummaryType | null = null;

      // Try extension first
      try {
        const extensionAvailable = await window.electronAPI.extensions.isAvailable('email-summarization');
        if (extensionAvailable.success && extensionAvailable.data) {
          console.log('[ThreadSummary] Using extension for summarization');
          const extResult = await window.electronAPI.extensions.summarizeThread(emailsForSummary);
          if (extResult.success && extResult.data) {
            // Map extension result to expected format
            result = {
              summary: extResult.data.summary || '',
              keyPoints: extResult.data.key_points || [],
              participants: extResult.data.participants || [],
              confidence: extResult.data.confidence || 0.7,
            };
          }
        }
      } catch (extError) {
        console.warn('[ThreadSummary] Extension call failed, using fallback:', extError);
      }

      // Fallback to inline implementation if extension didn't work
      if (!result) {
        console.log('[ThreadSummary] Using fallback summarization');
        result = await generateThreadSummaryFallback(emailsForSummary);
      }

      if (result) {
        setSummary(result);
        setExpanded(true);

        // Cache the summary
        const lastEmail = emails[emails.length - 1];
        await window.electronAPI.ai.saveThreadSummary({
          threadId,
          summary: result.summary,
          keyPoints: JSON.stringify(result.keyPoints),
          participants: JSON.stringify(result.participants),
          lastEmailDate: lastEmail?.date || Math.floor(Date.now() / 1000),
          emailCount: emails.length,
          processedAt: Math.floor(Date.now() / 1000),
          modelUsed: getDefaultProvider()?.model || 'unknown',
        });
      } else {
        setError('Failed to generate summary');
      }
    } catch (error) {
      console.error('[ThreadSummary] Failed to generate:', error);
      setError('Failed to generate summary');
    } finally {
      setLoading(false);
    }
  };

  // Don't render if feature is disabled or single email thread
  if (!isEnabled || emails.length < 2) {
    return null;
  }

  // No summary yet and not loading — show generate button
  if (!summary && !loading) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={generateSummary}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
        >
          <Sparkles className="h-4 w-4 text-purple-500" />
          Summarize Conversation
        </button>
        {error && (
          <span className="text-xs text-destructive">{error}</span>
        )}
      </div>
    );
  }

  // Loading state (no summary yet)
  if (loading && !summary) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
        <Loader2 className="h-4 w-4 animate-spin" />
        Generating summary...
      </div>
    );
  }

  // Summary exists — show collapsible summary
  return (
    <div className="border border-border rounded-lg bg-muted/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 text-left px-4 py-2.5"
      >
        <Sparkles className="h-4 w-4 text-purple-500" />
        <span className="text-sm font-medium flex-1">AI Summary</span>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {expanded && summary && (
        <div className="px-4 pb-3 space-y-3">
          {/* Main summary */}
          <p className="text-sm text-foreground">{summary.summary}</p>

          {/* Key points */}
          {summary.keyPoints.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Key Points
              </h4>
              <ul className="space-y-1">
                {summary.keyPoints.map((point, index) => (
                  <li key={index} className="flex items-start gap-2 text-sm text-foreground">
                    <CheckCircle className="h-3.5 w-3.5 text-green-500 mt-0.5 flex-shrink-0" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Participants */}
          {summary.participants.length > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Users className="h-3 w-3" />
              <span>{summary.participants.join(', ')}</span>
            </div>
          )}

          {/* Refresh button */}
          <button
            onClick={generateSummary}
            disabled={loading}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            Regenerate
          </button>
        </div>
      )}
    </div>
  );
}
