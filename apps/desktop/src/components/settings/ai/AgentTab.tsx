import {
  Bot, Shield, Brain, AlertTriangle, Globe, Key, FileText, RotateCcw,
  Save, Check, Eye, Zap, PenLine, FlaskConical, LayoutDashboard,
} from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

// Storage contract, defaults, load + main-process push all live in the shared
// agent-settings service so the app-boot restore path and this tab stay in
// lockstep (one source of truth). Aliased to the names used throughout the tab.
import {
  AGENT_CONFIG_KEY,
  loadAgentSettings as loadStoredSettings,
  pushAgentSettingsToBackend as pushToBackend,
  type AgentSettings,
} from '../../../services/agent-settings';

// ========== Prompt template support (DB-persisted via ai:* IPC) ==========

interface PromptTemplate {
  id: string;
  label: string;
  description: string | null;
  content: string;
  defaultContent: string;
  updatedAt: number;
  createdAt: number;
}

/**
 * Placeholder reference shown in the expanded prompt editor. All substituted
 * at call time in @sarvinbox/core (buildCategorizationPrompt / buildPlanPrompt
 * / buildDraftPrompt); unknown tokens stay as literal {{token}}.
 */
const PROMPT_VARIABLES: Record<string, Array<{ name: string; desc: string }>> = {
  categorization_system: [
    { name: 'userEmail', desc: 'Connected account email (empty before first IMAP connect).' },
    { name: 'userName', desc: 'Local-part of the email — the text before @.' },
    { name: 'userDomain', desc: 'Domain after @ (e.g. sarv.com), for same-domain heuristics.' },
    { name: 'categorySection', desc: 'Numbered list of enabled categories with their prompts, built from the Categorization tab.' },
    { name: 'spamPrompt', desc: 'Bundled spam-detection rules block.' },
  ],
  agent_plan: [
    { name: 'identity', desc: 'Your name, addresses and a first-person reminder, built from your profile and aliases.' },
    { name: 'webOption', desc: 'The web-search option line. Empty when Web Search is off.' },
    { name: 'webSearchesField', desc: 'The "web_searches" field in the example JSON. Empty when Web Search is off.' },
    { name: 'webWhenSection', desc: 'The "WHEN TO SEARCH THE WEB" guidance. Empty when Web Search is off.' },
  ],
  agent_draft: [
    { name: 'identity', desc: 'Same identity block as in the Plan prompt.' },
    { name: 'userName', desc: 'Your display name (profile → account name → recipient name → email local-part).' },
    { name: 'greeting', desc: 'The greeting you historically use with this sender (learned).' },
    { name: 'tone', desc: 'Learned tone for this sender — formal / casual / brief.' },
    { name: 'closing', desc: 'Your typical sign-off for this sender.' },
  ],
};

// ========== Shared bits ==========

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
      <input type="checkbox" checked={checked} onChange={onChange} className="sr-only peer" disabled={disabled} />
      <div className="w-11 h-6 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-ring rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
    </label>
  );
}

function ToggleRow({ label, description, checked, onChange, badge, disabled }: {
  label: string; description: string; checked: boolean; onChange: () => void; badge?: string; disabled?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 p-3 rounded-lg border border-border ${disabled ? 'opacity-50' : ''}`}>
      <div className="min-w-0">
        <div className="text-sm font-medium flex items-center gap-2">
          {label}
          {badge && <span className="text-[10px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded-full uppercase tracking-wide">{badge}</span>}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

function SliderRow({ label, hint, value, display, min, max, step, onChange }: {
  label: string; hint: string; value: number; display: string;
  min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <div>
      <label className="flex items-center justify-between text-sm mb-1">
        <span>{label}</span>
        <span className="text-muted-foreground tabular-nums">{display}</span>
      </label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
      />
      <p className="text-xs text-muted-foreground mt-1">{hint}</p>
    </div>
  );
}

function Section({ icon, title, caption, children }: {
  icon: React.ReactNode; title: string; caption?: string; children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-sm font-medium flex items-center gap-2">{icon}{title}</h3>
      {caption && <p className="text-xs text-muted-foreground mt-0.5 mb-3">{caption}</p>}
      <div className={`space-y-3 ${caption ? '' : 'mt-3'}`}>{children}</div>
    </div>
  );
}

// ========== Main component ==========

interface AgentTabProps { aiProviders: any[] }

export function AgentTab({ aiProviders }: AgentTabProps) {
  const [settings, setSettings] = useState<AgentSettings>(loadStoredSettings);
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');

  // Prompt template state (DB-backed, independent of localStorage settings)
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [promptSaving, setPromptSaving] = useState<Record<string, boolean>>({});
  const [promptSaved, setPromptSaved] = useState<Record<string, boolean>>({});
  const [expandedPrompt, setExpandedPrompt] = useState<string | null>(null);

  const hasProvider = aiProviders.length > 0;

  const loadPrompts = useCallback(async () => {
    try {
      const result = await window.electronAPI.ai.listPromptTemplates();
      if (result?.success && Array.isArray(result.data)) {
        setPrompts(result.data);
        const drafts: Record<string, string> = {};
        for (const p of result.data) drafts[p.id] = p.content;
        setPromptDrafts(drafts);
      }
    } catch { /* prompts section simply stays hidden */ }
  }, []);

  useEffect(() => {
    // Re-sync the saved config to the main process on mount. The pipeline
    // starts with enabled:false after every app launch (main.ts) and only
    // hears about user settings via agent:setConfig — without this push the
    // saved config wouldn't apply until the user flips a toggle.
    pushToBackend(loadStoredSettings());
    loadPrompts();
  }, [loadPrompts]);

  const updateMany = (patch: Partial<AgentSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify(next));
    pushToBackend(next);
    if ('enabled' in patch) {
      window.electronAPI.agent.setEnabled(!!patch.enabled).catch(() => {});
    }
  };

  const update = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) =>
    updateMany({ [key]: value } as Partial<AgentSettings>);

  const handleWebSearchToggle = () => {
    if (settings.searchWebEnabled) {
      update('searchWebEnabled', false);
      setShowKeyInput(false);
    } else if (settings.tavilyApiKey) {
      update('searchWebEnabled', true);
    } else {
      setShowKeyInput(true);
      setKeyDraft('');
    }
  };

  const savePrompt = async (id: string) => {
    const content = promptDrafts[id];
    if (typeof content !== 'string') return;
    setPromptSaving(s => ({ ...s, [id]: true }));
    try {
      const result = await window.electronAPI.ai.updatePromptTemplate(id, content);
      if (result?.success) {
        setPromptSaved(s => ({ ...s, [id]: true }));
        setTimeout(() => setPromptSaved(s => ({ ...s, [id]: false })), 2000);
        await loadPrompts();
      }
    } finally {
      setPromptSaving(s => ({ ...s, [id]: false }));
    }
  };

  const resetPrompt = async (id: string) => {
    const result = await window.electronAPI.ai.resetPromptTemplate(id);
    if (result?.success) await loadPrompts();
  };

  return (
    <div className="space-y-6">
      {/* Master switch */}
      <div className={`rounded-lg border p-4 ${settings.enabled ? 'border-violet-500/40 bg-violet-500/5' : 'border-border bg-muted/30'}`}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <Bot className={`h-5 w-5 flex-shrink-0 ${settings.enabled ? 'text-violet-600 dark:text-violet-400' : 'text-muted-foreground'}`} />
            <div className="min-w-0">
              <div className="font-medium flex items-center gap-2">
                AI Assist
                {settings.enabled && (
                  <span className="text-xs px-2 py-0.5 bg-green-500/15 text-green-600 dark:text-green-400 rounded-full">Active</span>
                )}
              </div>
              <div className="text-sm text-muted-foreground">
                Master switch for AI categorization and the email agent. When off, no LLM
                calls are made — local priority scoring and behavior learning keep running.
              </div>
            </div>
          </div>
          <Toggle checked={settings.enabled} onChange={() => update('enabled', !settings.enabled)} disabled={!hasProvider} />
        </div>
      </div>

      {!hasProvider && (
        <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
            <span className="font-medium text-yellow-600 dark:text-yellow-400">No AI provider</span>
          </div>
          <div className="text-muted-foreground mt-1">
            Add a provider in the Providers tab to enable AI Assist.
          </div>
        </div>
      )}

      {/* How it works */}
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium mb-3">How it works</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs text-muted-foreground">
          <div className="flex gap-2">
            <Eye className="h-4 w-4 text-blue-500 flex-shrink-0 mt-0.5" />
            <span><span className="font-medium text-foreground">Observes.</span> Your reads, replies, archives and deletes — plus synced history — are logged as learning signals.</span>
          </div>
          <div className="flex gap-2">
            <Brain className="h-4 w-4 text-violet-500 flex-shrink-0 mt-0.5" />
            <span><span className="font-medium text-foreground">Learns.</span> It correlates categories with what you do ("you archive 90% of newsletters") per sender and tag.</span>
          </div>
          <div className="flex gap-2">
            <Zap className="h-4 w-4 text-green-500 flex-shrink-0 mt-0.5" />
            <span><span className="font-medium text-foreground">Acts.</span> It drafts replies into your Drafts folder and — only where you allow it below — handles routine email itself.</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1.5">
          <LayoutDashboard className="h-3.5 w-3.5" />
          Watch what it's doing (and undo anything) in the Email Agent section of the main sidebar.
        </p>
      </div>

      {settings.enabled && (
        <>
          {/* Autonomy */}
          <Section
            icon={<Zap className="h-4 w-4 text-violet-500" />}
            title="Autonomy"
            caption="What the agent may do on its own once a pattern is proven (5+ samples, consistent action). Everything it does is logged and undoable."
          >
            <ToggleRow
              label="Auto-mark as read"
              description="Mark noise and newsletter-style emails as read when you'd clearly never open them"
              checked={settings.autoRead}
              onChange={() => update('autoRead', !settings.autoRead)}
            />
            <ToggleRow
              label="Auto-triage"
              description="Archive (or spam-flag) emails that match a strong learned pattern of you doing the same"
              checked={settings.autoTriage}
              onChange={() => update('autoTriage', !settings.autoTriage)}
            />
            <ToggleRow
              label="Smart prioritize"
              description="Rank your inbox by how much each email matters to you: higher-scored threads appear first (newest first within equal scores). The score is computed locally from your own reply/read patterns — no AI calls — and is separate from categorization, which decides the Important section"
              checked={settings.autoPrioritize}
              onChange={() => update('autoPrioritize', !settings.autoPrioritize)}
            />
            <div className="p-3 rounded-lg border border-border">
              <SliderRow
                label="Act-without-asking confidence"
                hint="Below this confidence the agent never acts on its own — this also gates Auto-send replies in the section below"
                value={settings.autoActThreshold}
                display={`${Math.round(settings.autoActThreshold * 100)}%`}
                min={0.5} max={0.99} step={0.01}
                onChange={v => update('autoActThreshold', v)}
              />
            </div>
          </Section>

          {/* Reply drafting */}
          <Section
            icon={<PenLine className="h-4 w-4 text-green-500" />}
            title="Reply drafting"
            caption="When an email looks like it needs an answer, the agent writes a reply in your voice and saves it to your Drafts folder — it opens automatically when you view the email. The agent never sends anything unless you enable Auto-send below."
          >
            <ToggleRow
              label="Draft replies automatically"
              description="When an email is worth replying to, the agent writes a reply and saves it to your Drafts folder for you to review and send"
              checked={settings.draftReplies}
              onChange={() => update('draftReplies', !settings.draftReplies)}
            />
            <ToggleRow
              label="Auto-send confident replies"
              description="Actually sends the reply on your behalf when confidence is at least the act-without-asking threshold. Replies below it are saved as drafts instead. Off = everything stays a draft (recommended)"
              checked={settings.autoReply}
              onChange={() => update('autoReply', !settings.autoReply)}
              disabled={!settings.draftReplies}
            />
            <div className="p-3 rounded-lg border border-border">
              <SliderRow
                label="Suggestion confidence"
                hint="Minimum confidence before the agent drafts a reply at all"
                value={settings.suggestThreshold}
                display={`${Math.round(settings.suggestThreshold * 100)}%`}
                min={0.2} max={0.8} step={0.01}
                onChange={v => update('suggestThreshold', v)}
              />
            </div>

            {/* Web search (Tavily) */}
            <div className="rounded-lg border border-border p-3 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                    Web search while drafting
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Lets the drafter look up product or company facts via Tavily instead of guessing. Off by default.
                  </div>
                </div>
                <Toggle checked={settings.searchWebEnabled} onChange={handleWebSearchToggle} />
              </div>

              {showKeyInput && !settings.tavilyApiKey && (
                <div className="pt-2 border-t border-border space-y-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Key className="h-3 w-3" />
                    <span>
                      Enter your Tavily API key.{' '}
                      <a href="https://tavily.com" target="_blank" rel="noreferrer" className="text-primary hover:underline">
                        Get a free key at tavily.com
                      </a>{' '}
                      (1,000 searches/month free).
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="password"
                      value={keyDraft}
                      onChange={e => setKeyDraft(e.target.value)}
                      placeholder="tvly-..."
                      className="flex-1 px-3 py-2 bg-background border border-input rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      autoFocus
                    />
                    <button
                      onClick={() => {
                        const trimmed = keyDraft.trim();
                        if (!trimmed) return;
                        updateMany({ tavilyApiKey: trimmed, searchWebEnabled: true });
                        setShowKeyInput(false);
                        setKeyDraft('');
                      }}
                      disabled={!keyDraft.trim()}
                      className="px-3 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Save & enable
                    </button>
                    <button
                      onClick={() => { setShowKeyInput(false); setKeyDraft(''); }}
                      className="px-3 py-2 text-sm border border-input rounded-lg hover:bg-accent"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {settings.tavilyApiKey && (
                <div className="pt-2 border-t border-border flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Key className="h-3 w-3" />
                    <span>Tavily key: <span className="font-mono">{settings.tavilyApiKey.slice(0, 6)}…{settings.tavilyApiKey.slice(-4)}</span></span>
                  </div>
                  <button
                    onClick={() => updateMany({ tavilyApiKey: '', searchWebEnabled: false })}
                    className="text-red-500 hover:text-red-600 hover:underline"
                  >
                    Remove key
                  </button>
                </div>
              )}
            </div>
          </Section>

          {/* Safety & limits */}
          <Section
            icon={<Shield className="h-4 w-4 text-muted-foreground" />}
            title="Safety & limits"
            caption="Hard guardrails that apply no matter how confident the agent is."
          >
            <div className="p-3 rounded-lg border border-border space-y-1.5">
              <label className="block text-sm">Never auto-delete or spam-flag from</label>
              <input
                type="text"
                value={settings.neverAutoDeleteFrom}
                onChange={e => update('neverAutoDeleteFrom', e.target.value)}
                placeholder="boss@company.com, important-client.com"
                className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">Comma-separated addresses or domains. Matched against both sender address and domain.</p>
            </div>
            <div className="p-3 rounded-lg border border-border space-y-1.5">
              <label className="block text-sm">Never draft replies to</label>
              <input
                type="text"
                value={settings.neverAutoReplyTo}
                onChange={e => update('neverAutoReplyTo', e.target.value)}
                placeholder="noreply@, support@, billing@"
                className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="text-xs text-muted-foreground">Senders the agent must never draft — or auto-send — replies to. Checked again at send time.</p>
            </div>
            <div className="p-3 rounded-lg border border-border">
              <SliderRow
                label="Max autonomous actions per hour"
                hint="Circuit breaker — when the limit is hit, the agent stops acting until the next hour"
                value={settings.maxAutoActionsPerHour}
                display={String(settings.maxAutoActionsPerHour)}
                min={5} max={200} step={5}
                onChange={v => update('maxAutoActionsPerHour', Math.round(v))}
              />
            </div>
            <div className={`rounded-lg border p-3 ${settings.testMode ? 'border-amber-500/40 bg-amber-500/5' : 'border-border'}`}>
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-2">
                    <FlaskConical className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    Test mode
                    {settings.testMode && (
                      <span className="text-xs px-2 py-0.5 bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded-full">Active</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    Agent actions update the local database only — nothing is synced to your IMAP server, so you can try the agent risk-free.
                  </div>
                </div>
                <Toggle checked={settings.testMode} onChange={() => update('testMode', !settings.testMode)} />
              </div>
            </div>
          </Section>

          {/* Prompt templates */}
          {prompts.length > 0 && (
            <Section
              icon={<FileText className="h-4 w-4 text-muted-foreground" />}
              title="Prompt templates"
              caption="Advanced: tune the exact prompts used for categorization and reply drafting. Placeholders like {{userName}} are substituted at runtime; Reset reverts to the default."
            >
              {prompts.map(p => (
                <PromptEditor
                  key={p.id}
                  prompt={p}
                  draft={promptDrafts[p.id] ?? ''}
                  expanded={expandedPrompt === p.id}
                  saving={!!promptSaving[p.id]}
                  saved={!!promptSaved[p.id]}
                  onToggle={() => setExpandedPrompt(expandedPrompt === p.id ? null : p.id)}
                  onDraftChange={v => setPromptDrafts(s => ({ ...s, [p.id]: v }))}
                  onSave={() => savePrompt(p.id)}
                  onReset={() => resetPrompt(p.id)}
                />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

// ========== Prompt editor ==========

function PromptEditor({ prompt, draft, expanded, saving, saved, onToggle, onDraftChange, onSave, onReset }: {
  prompt: PromptTemplate; draft: string; expanded: boolean; saving: boolean; saved: boolean;
  onToggle: () => void; onDraftChange: (v: string) => void; onSave: () => void; onReset: () => void;
}) {
  const isDirty = draft !== prompt.content;
  const isCustomized = prompt.content !== prompt.defaultContent;
  const variables = PROMPT_VARIABLES[prompt.id] ?? [];

  return (
    <div className="border border-border rounded-lg">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/40 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{prompt.label}</span>
            {isCustomized && (
              <span className="text-[10px] px-1.5 py-0.5 bg-violet-500/15 text-violet-600 dark:text-violet-400 rounded-full uppercase tracking-wide">
                Customized
              </span>
            )}
          </div>
          {prompt.description && (
            <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{prompt.description}</div>
          )}
        </div>
        <span className="text-xs text-muted-foreground flex-shrink-0">{expanded ? 'Hide' : 'Edit'}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t border-border">
          {variables.length > 0 && (
            <div className="pt-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">Available variables</div>
              <div className="rounded-lg border border-border divide-y divide-border">
                {variables.map(v => (
                  <div key={v.name} className="px-3 py-2">
                    <code className="text-[11px] font-mono bg-violet-500/10 text-violet-700 dark:text-violet-300 px-1.5 py-0.5 rounded border border-violet-500/20">
                      {`{{${v.name}}}`}
                    </code>
                    <div className="text-[11px] text-muted-foreground leading-relaxed mt-1">{v.desc}</div>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Case-sensitive. Unknown tokens are left in the output as-is so typos stay visible.
              </p>
            </div>
          )}
          <textarea
            value={draft}
            onChange={e => onDraftChange(e.target.value)}
            rows={14}
            spellCheck={false}
            className="w-full font-mono text-[11px] leading-relaxed p-2 bg-muted/30 border border-border rounded resize-y focus:outline-none focus:ring-1 focus:ring-primary/50"
          />
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              {draft.length} chars
              {isDirty && <span className="text-amber-600 dark:text-amber-400 ml-2">• Unsaved changes</span>}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onReset}
                disabled={!isCustomized}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-border rounded hover:bg-muted/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Revert to default"
              >
                <RotateCcw className="h-3 w-3" /> Reset
              </button>
              <button
                type="button"
                onClick={onSave}
                disabled={!isDirty || saving}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saved ? <><Check className="h-3 w-3" /> Saved</> : <><Save className="h-3 w-3" /> {saving ? 'Saving…' : 'Save'}</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
