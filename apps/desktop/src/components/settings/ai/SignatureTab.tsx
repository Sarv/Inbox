import { Mail, Loader2, Check, X, Trash2, Sparkles, FileSignature, AlertCircle } from 'lucide-react';
import { useState, useEffect } from 'react';

import {
  AIProvider,
  detectSignature,
  SignatureDetectionResult,
} from '../../../services/ai-service';
import type { AIFeatureConfig, SignaturePattern } from '../types';
import { DEFAULT_AI_FEATURES, AI_FEATURES_KEY } from '../types';

interface SignatureTabProps {
  aiProviders: AIProvider[];
}

export function SignatureTab({ aiProviders }: SignatureTabProps) {
  // Feature state (just the signature-detection feature)
  const [feature, setFeature] = useState<AIFeatureConfig>(
    DEFAULT_AI_FEATURES.find(f => f.id === 'signature-detection')!
  );
  // Signature patterns state
  const [showSignaturesModal, setShowSignaturesModal] = useState(false);
  const [signaturePatterns, setSignaturePatterns] = useState<SignaturePattern[]>([]);
  const [signaturePatternsTotal, setSignaturePatternsTotal] = useState(0);
  const [loadingSignatures, setLoadingSignatures] = useState(false);
  const [deletingSignatureId, setDeletingSignatureId] = useState<string | null>(null);

  // Test signature detection state
  const [showSignatureTestModal, setShowSignatureTestModal] = useState(false);
  const [testSenderEmail, setTestSenderEmail] = useState('sender@example.com');
  const [testEmailBody, setTestEmailBody] = useState('');
  const [testingSignatureDetection, setTestingSignatureDetection] = useState(false);
  const [signatureTestResult, setSignatureTestResult] = useState<SignatureDetectionResult | null>(null);
  const [recentEmails, setRecentEmails] = useState<any[]>([]);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [selectedTestEmailId, setSelectedTestEmailId] = useState<string | null>(null);
  const [loadingSelectedEmail, setLoadingSelectedEmail] = useState(false);

  // Load feature state on mount
  useEffect(() => {
    const stored = localStorage.getItem(AI_FEATURES_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        const saved = parsed.find((f: AIFeatureConfig) => f.id === 'signature-detection');
        if (saved) {
          const defaultFeature = DEFAULT_AI_FEATURES.find(f => f.id === 'signature-detection')!;
          setFeature({
            ...defaultFeature,
            enabled: saved.enabled,
            userPrompt: saved.userPrompt || defaultFeature.userPrompt,
          });
        }
      } catch (e) {
        console.error('Failed to parse AI features:', e);
      }
    }
  }, []);

  // Load signatures when modal opens
  useEffect(() => {
    if (showSignaturesModal) {
      loadSignaturePatterns();
    }
  }, [showSignaturesModal]);

  // Load signature count on mount
  useEffect(() => {
    const loadCount = async () => {
      try {
        const result = await window.electronAPI.signatures.list({ limit: 1 });
        if (result.success && result.data) {
          setSignaturePatternsTotal(result.data.total);
        }
      } catch (error) {
        console.error('Failed to load signature count:', error);
      }
    };
    loadCount();
  }, []);

  // Load emails when test modal opens
  useEffect(() => {
    if (showSignatureTestModal) {
      loadRecentEmails();
    }
  }, [showSignatureTestModal]);

  const saveFeature = (updated: AIFeatureConfig) => {
    setFeature(updated);
    // Update just this feature in the stored array
    const stored = localStorage.getItem(AI_FEATURES_KEY);
    let features: AIFeatureConfig[] = DEFAULT_AI_FEATURES;
    if (stored) {
      try {
        features = JSON.parse(stored);
      } catch {}
    }
    const merged = features.map(f => f.id === 'signature-detection' ? updated : f);
    localStorage.setItem(AI_FEATURES_KEY, JSON.stringify(merged));
  };

  const toggleFeature = () => {
    saveFeature({ ...feature, enabled: !feature.enabled });
  };

  const updateUserPrompt = (userPrompt: string) => {
    saveFeature({ ...feature, userPrompt });
  };

  const resetPrompt = () => {
    const defaultFeature = DEFAULT_AI_FEATURES.find(f => f.id === 'signature-detection')!;
    updateUserPrompt(defaultFeature.userPrompt);
  };

  const loadSignaturePatterns = async () => {
    setLoadingSignatures(true);
    try {
      const result = await window.electronAPI.signatures.list({ limit: 100 });
      if (result.success && result.data) {
        setSignaturePatterns(result.data.patterns);
        setSignaturePatternsTotal(result.data.total);
      }
    } catch (error) {
      console.error('Failed to load signature patterns:', error);
    } finally {
      setLoadingSignatures(false);
    }
  };

  const handleDeleteSignature = async (id: string) => {
    setDeletingSignatureId(id);
    try {
      const result = await window.electronAPI.signatures.delete(id);
      if (result.success) {
        setSignaturePatterns(prev => prev.filter(p => p.id !== id));
        setSignaturePatternsTotal(prev => prev - 1);
      }
    } catch (error) {
      console.error('Failed to delete signature pattern:', error);
    } finally {
      setDeletingSignatureId(null);
    }
  };

  const handleClearAllSignatures = async () => {
    if (!confirm('Are you sure you want to clear all cached signatures? This cannot be undone.')) {
      return;
    }
    try {
      const result = await window.electronAPI.signatures.clear();
      if (result.success) {
        setSignaturePatterns([]);
        setSignaturePatternsTotal(0);
      }
    } catch (error) {
      console.error('Failed to clear signature patterns:', error);
    }
  };

  const loadRecentEmails = async () => {
    setLoadingEmails(true);
    try {
      const foldersResult = await window.electronAPI.folders.list();
      if (foldersResult.success && foldersResult.data) {
        const inboxFolder = foldersResult.data.find((f: any) =>
          f.name.toLowerCase() === 'inbox' || f.path.toLowerCase() === 'inbox'
        );
        if (inboxFolder) {
          const emailsResult = await window.electronAPI.emails.list(inboxFolder.id, 20, 0);
          if (emailsResult.success && emailsResult.data) {
            setRecentEmails(emailsResult.data);
          }
        }
      }
    } catch (error) {
      console.error('Failed to load recent emails:', error);
    } finally {
      setLoadingEmails(false);
    }
  };

  const handleSelectTestEmail = async (email: any) => {
    setSelectedTestEmailId(email.id);
    setTestSenderEmail(email.fromAddress);
    setSignatureTestResult(null);
    setLoadingSelectedEmail(true);

    try {
      const result = await window.electronAPI.emails.get(email.id);
      if (result.success && result.data) {
        setTestEmailBody(result.data.rawBody || result.data.cleanBody || '');
      } else {
        setTestEmailBody(email.rawBody || email.cleanBody || '');
      }
    } catch (error) {
      console.error('Failed to fetch full email:', error);
      setTestEmailBody(email.rawBody || email.cleanBody || '');
    } finally {
      setLoadingSelectedEmail(false);
    }
  };

  const handleTestSignatureDetection = async () => {
    setTestingSignatureDetection(true);
    setSignatureTestResult(null);
    try {
      const result = await detectSignature(testEmailBody, testSenderEmail, selectedTestEmailId || undefined);
      setSignatureTestResult(result);

      if (result.hasSignature && result.htmlSelector) {
        const countResult = await window.electronAPI.signatures.list({ limit: 1 });
        if (countResult.success && countResult.data) {
          setSignaturePatternsTotal(countResult.data.total);
        }
      }
    } catch (error) {
      console.error('Test detection failed:', error);
    } finally {
      setTestingSignatureDetection(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Feature toggle card */}
      <div className={`rounded-lg border p-4 ${feature.enabled ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/30'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <FileSignature className={`h-5 w-5 flex-shrink-0 ${feature.enabled ? 'text-primary' : 'text-muted-foreground'}`} />
            <div className="min-w-0">
              <div className="font-medium flex items-center gap-2">
                {feature.name}
                {feature.enabled && (
                  <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-600 dark:text-green-400 rounded-full">Active</span>
                )}
              </div>
              <div className="text-sm text-muted-foreground truncate">{feature.description}</div>
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
            <input
              type="checkbox"
              checked={feature.enabled}
              onChange={toggleFeature}
              className="sr-only peer"
              disabled={aiProviders.length === 0}
            />
            <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-ring rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
          </label>
        </div>
      </div>

      {/* System Prompt (Read-only) */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-muted-foreground">
            System Prompt (Read-only)
          </label>
          <span className="text-xs px-2 py-0.5 bg-muted text-muted-foreground rounded">Hardcoded</span>
        </div>
        <div className="p-3 bg-muted/50 rounded-md border border-border">
          <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-40 overflow-y-auto">
            {feature.systemPrompt}
          </pre>
        </div>
      </div>

      {/* User Prompt (Editable) */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium">
            User Prompt (Editable)
          </label>
          <button
            onClick={resetPrompt}
            className="text-xs px-2 py-1 hover:bg-accent rounded transition-colors text-muted-foreground hover:text-foreground"
          >
            Reset to Default
          </button>
        </div>
        <textarea
          value={feature.userPrompt}
          onChange={(e) => updateUserPrompt(e.target.value)}
          className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm font-mono min-h-[80px] focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          placeholder="Enter custom prompt to append to AI requests..."
        />
        <p className="mt-1 text-xs text-muted-foreground">
          This prompt will be sent along with the email content to the AI. The email body will be automatically appended.
        </p>
      </div>

      {/* Actions */}
      <div className="pt-2 border-t border-border">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowSignatureTestModal(true)}
            disabled={aiProviders.length === 0 || !feature.enabled}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-primary text-primary-foreground hover:bg-primary/90 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Sparkles className="h-4 w-4" />
            Test Detection
          </button>
          <button
            onClick={() => setShowSignaturesModal(true)}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-muted hover:bg-accent rounded-md transition-colors"
          >
            <FileSignature className="h-4 w-4" />
            View Cached Selectors ({signaturePatternsTotal})
          </button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Test the detection with sample text, or view cached selectors. Cached selectors are HTML element patterns used to find signatures without AI.
        </p>
      </div>

      {aiProviders.length === 0 && (
        <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm">
          <div className="font-medium text-yellow-600 dark:text-yellow-400">No AI Provider Configured</div>
          <div className="text-muted-foreground mt-1">
            Add an AI provider in the Providers tab to enable signature detection.
          </div>
        </div>
      )}

      {/* Signatures Modal */}
      {showSignaturesModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <FileSignature className="h-5 w-5 text-primary" />
                <h3 className="text-lg font-semibold">Cached Signature Selectors</h3>
                <span className="text-sm text-muted-foreground">({signaturePatternsTotal} total)</span>
              </div>
              <div className="flex items-center gap-2">
                {signaturePatterns.length > 0 && (
                  <button
                    onClick={handleClearAllSignatures}
                    className="text-xs px-2 py-1 text-destructive hover:bg-destructive/10 rounded transition-colors"
                  >
                    Clear All
                  </button>
                )}
                <button
                  onClick={() => setShowSignaturesModal(false)}
                  className="p-1.5 hover:bg-accent rounded transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {loadingSignatures ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : signaturePatterns.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <FileSignature className="h-12 w-12 text-muted-foreground mb-3" />
                  <div className="text-muted-foreground">No signature selectors cached yet</div>
                  <p className="text-sm text-muted-foreground mt-1">
                    HTML element selectors (like <code className="bg-muted px-1 rounded">div.gmail_signature</code>) will be cached when emails are processed.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {signaturePatterns.map((pattern) => (
                    <div
                      key={pattern.id}
                      className="border border-border rounded-lg p-4 bg-muted/30"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-2 flex-wrap">
                            <span className="font-medium truncate">{pattern.email}</span>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${
                              pattern.confidence === 'high' ? 'bg-green-500/20 text-green-600' :
                              pattern.confidence === 'medium' ? 'bg-yellow-500/20 text-yellow-600' :
                              'bg-red-500/20 text-red-600'
                            }`}>
                              {pattern.confidence}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              Used {pattern.usageCount}x
                            </span>
                          </div>

                          <div className="mb-2">
                            <div className="text-xs text-muted-foreground mb-1">CSS Selector:</div>
                            <code className="text-xs bg-primary/10 text-primary px-2 py-1 rounded font-mono">
                              {pattern.htmlSelector}
                            </code>
                          </div>

                          {pattern.sampleHtml && (
                            <div className="mb-2">
                              <div className="text-xs text-muted-foreground mb-1">Sample HTML:</div>
                              <div className="bg-background rounded p-2 border border-border">
                                <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-24 overflow-y-auto">
                                  {pattern.sampleHtml}
                                </pre>
                              </div>
                            </div>
                          )}

                          {pattern.emailIds && pattern.emailIds.length > 0 && (
                            <div className="mb-2">
                              <div className="text-xs text-muted-foreground">
                                Found in {pattern.emailIds.length} email(s)
                              </div>
                            </div>
                          )}

                          <div className="text-xs text-muted-foreground">
                            Last used: {new Date(pattern.lastUsed * 1000).toLocaleString()}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteSignature(pattern.id)}
                          disabled={deletingSignatureId === pattern.id}
                          className="p-2 text-destructive hover:bg-destructive/10 rounded transition-colors disabled:opacity-50"
                          title="Remove this signature"
                        >
                          {deletingSignatureId === pattern.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-border bg-muted/30">
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <p>
                  Cached selectors are CSS patterns (like <code className="bg-muted px-1 rounded">div.gmail_signature</code>) that identify signature elements in emails.
                  When a new email arrives from a known sender, the cached selector is used to hide the signature without AI.
                  Remove entries if signatures aren't detected correctly.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Test Signature Detection Modal */}
      {showSignatureTestModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                <h3 className="text-lg font-semibold">Test Signature Detection</h3>
              </div>
              <button
                onClick={() => {
                  setShowSignatureTestModal(false);
                  setSignatureTestResult(null);
                }}
                className="p-1.5 hover:bg-accent rounded transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-2">Select an Email from Inbox</label>
                {loadingEmails ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 border border-border rounded-md">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading recent emails...
                  </div>
                ) : recentEmails.length === 0 ? (
                  <div className="text-sm text-muted-foreground p-3 border border-border rounded-md">
                    No emails found. Connect to your email account first.
                  </div>
                ) : (
                  <div className="border border-border rounded-md max-h-[200px] overflow-y-auto">
                    {recentEmails.map((email) => (
                      <button
                        key={email.id}
                        onClick={() => handleSelectTestEmail(email)}
                        disabled={loadingSelectedEmail}
                        className={`w-full text-left px-3 py-2 border-b border-border last:border-b-0 hover:bg-accent/50 transition-colors disabled:cursor-wait ${
                          selectedTestEmailId === email.id ? 'bg-primary/10 border-l-2 border-l-primary' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {loadingSelectedEmail && selectedTestEmailId === email.id ? (
                            <Loader2 className="h-4 w-4 text-primary animate-spin flex-shrink-0" />
                          ) : (
                            <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate">
                              {email.fromName || email.fromAddress}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {email.subject}
                            </div>
                          </div>
                          <div className="text-xs text-muted-foreground flex-shrink-0">
                            {new Date(email.date * 1000).toLocaleDateString()}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-3">
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">or enter manually</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Sender Email</label>
                <input
                  type="email"
                  value={testSenderEmail}
                  onChange={(e) => {
                    setTestSenderEmail(e.target.value);
                    setSelectedTestEmailId(null);
                  }}
                  className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="sender@example.com"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Used for caching - detected signatures are stored per email address
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Email Body (HTML Source)</label>
                <div className="relative">
                  <textarea
                    value={testEmailBody}
                    onChange={(e) => {
                      setTestEmailBody(e.target.value);
                      setSelectedTestEmailId(null);
                    }}
                    disabled={loadingSelectedEmail}
                    className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm font-mono min-h-[150px] focus:outline-none focus:ring-2 focus:ring-ring resize-y disabled:opacity-50"
                    placeholder="Select an email above or paste email source here..."
                  />
                  {loadingSelectedEmail && (
                    <div className="absolute inset-0 flex items-center justify-center bg-background/50 rounded-md">
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading email source...
                      </div>
                    </div>
                  )}
                </div>
                {testEmailBody && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {testEmailBody.length.toLocaleString()} characters loaded
                  </p>
                )}
              </div>

              <button
                onClick={handleTestSignatureDetection}
                disabled={testingSignatureDetection || loadingSelectedEmail || !testEmailBody.trim()}
                className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {testingSignatureDetection ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Detecting...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Run Detection
                  </>
                )}
              </button>

              {signatureTestResult && (
                <div className={`p-4 rounded-lg border ${signatureTestResult.hasSignature ? 'border-green-500/50 bg-green-500/10' : 'border-yellow-500/50 bg-yellow-500/10'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    {signatureTestResult.hasSignature ? (
                      <Check className="h-5 w-5 text-green-600" />
                    ) : (
                      <AlertCircle className="h-5 w-5 text-yellow-600" />
                    )}
                    <span className="font-medium">
                      {signatureTestResult.hasSignature ? 'Signature Detected' : 'No Signature Found'}
                    </span>
                    {signatureTestResult.fromCache && (
                      <span className="text-xs px-2 py-0.5 bg-blue-500/20 text-blue-600 rounded-full">From Cache</span>
                    )}
                    {signatureTestResult.hasSignature && (
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        signatureTestResult.confidence === 'high' ? 'bg-green-500/20 text-green-600' :
                        signatureTestResult.confidence === 'medium' ? 'bg-yellow-500/20 text-yellow-600' :
                        'bg-red-500/20 text-red-600'
                      }`}>
                        {signatureTestResult.confidence} confidence
                      </span>
                    )}
                  </div>

                  {signatureTestResult.hasSignature && (
                    <div className="mt-3 space-y-3">
                      {signatureTestResult.htmlSelector && (
                        <div>
                          <div className="text-sm font-medium mb-1">CSS Selector:</div>
                          <code className="text-sm bg-primary/10 text-primary px-3 py-1.5 rounded font-mono block">
                            {signatureTestResult.htmlSelector}
                          </code>
                          <p className="text-xs text-muted-foreground mt-1">
                            Use this selector to find signatures in emails from this sender
                          </p>
                        </div>
                      )}

                      {signatureTestResult.sampleHtml && (
                        <div>
                          <div className="text-sm font-medium mb-1">Signature HTML:</div>
                          <div className="p-3 bg-background rounded border border-border">
                            <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                              {signatureTestResult.sampleHtml}
                            </pre>
                          </div>
                        </div>
                      )}

                      {signatureTestResult.signatureText && (
                        <div>
                          <div className="text-sm font-medium mb-1">Signature Text:</div>
                          <div className="p-3 bg-background rounded border border-border">
                            <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono">
                              {signatureTestResult.signatureText}
                            </pre>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-border bg-muted/30">
              <div className="flex items-start gap-2 text-xs text-muted-foreground">
                <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <p>
                  The AI will analyze the email HTML to find the signature element and return a CSS selector.
                  This selector is cached per sender, allowing signature detection without AI calls for future emails.
                  In email threads with multiple replies, each sender's signature can be identified separately.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
