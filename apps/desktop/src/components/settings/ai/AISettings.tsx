import { Save } from 'lucide-react';
import { useState, useEffect } from 'react';

import { SETTINGS_KEY } from '../../../config/inbox-types';
import { AIProvider, loadAISettings } from '../../../services/ai-service';
import { useEmailStore } from '../../../store/email-store';
import { AIBoxDashboard } from '../../aibox/AIBoxDashboard';
import { type AppSettings, defaultSettings } from '../types';

import { AgentTab } from './AgentTab';
import { CategorizationTab } from './CategorizationTab';
import { ConversationTab } from './ConversationTab';
import { ProvidersTab } from './ProvidersTab';
import { SignatureTab } from './SignatureTab';

type AISettingsTab = 'dashboard' | 'providers' | 'categorization' | 'signatures' | 'conversation' | 'agent';

const tabs: { id: AISettingsTab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'providers', label: 'Providers' },
  { id: 'categorization', label: 'Categorization' },
  { id: 'signatures', label: 'Signatures' },
  { id: 'conversation', label: 'Conversation Mode' },
  { id: 'agent', label: 'Email Agent' },
];

export function AISettings({ initialTab, onDirtyChange }: { initialTab?: AISettingsTab; onDirtyChange?: (dirty: boolean) => void } = {}) {
  const [activeTab, setActiveTab] = useState<AISettingsTab>(initialTab ?? 'dashboard');
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [hasChanges, setHasChanges] = useState(false);
  const [saved, setSaved] = useState(false);
  const [aiProviders, setAiProviders] = useState<AIProvider[]>([]);

  // Report unsaved-changes state up so navigating away can prompt to discard.
  useEffect(() => {
    onDirtyChange?.(hasChanges);
  }, [hasChanges, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Load settings from localStorage
  useEffect(() => {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setSettings({ ...defaultSettings, ...parsed });
      } catch (e) {
        console.error('Failed to parse settings:', e);
      }
    }
  }, []);

  // Load AI providers on mount
  useEffect(() => {
    const aiSettings = loadAISettings();
    setAiProviders(aiSettings.providers);
  }, []);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
    setSaved(false);
  };

  const saveSettings = () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    setHasChanges(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);

    useEmailStore.getState().reloadInboxSettings();
  };

  return (
    <div className="flex-1 h-full overflow-hidden bg-background">
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h1 className="text-2xl font-semibold">AI Settings</h1>
          {/* The header Save button only drives the Categorization tab (the one
              wired to updateSetting/localStorage). Every other tab self-saves
              (Providers persists immediately, Agent has per-prompt saves, etc.),
              so showing an always-disabled "Save Changes" there was misleading —
              render it only where it does something. */}
          {activeTab === 'categorization' && (
            <div className="flex items-center gap-3">
              {saved && (
                <span className="text-sm text-green-600">Settings saved!</span>
              )}
              <button
                onClick={saveSettings}
                disabled={!hasChanges}
                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  hasChanges
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                }`}
              >
                <Save className="h-4 w-4" />
                Save Changes
              </button>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="px-6 border-b border-border">
          <div className="flex gap-1 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {activeTab === 'dashboard' && (
            <AIBoxDashboard />
          )}
          <div className="max-w-3xl">
            {activeTab === 'providers' && (
              <ProvidersTab aiProviders={aiProviders} setAiProviders={setAiProviders} />
            )}
            {activeTab === 'categorization' && (
              <CategorizationTab aiProviders={aiProviders} settings={settings} updateSetting={updateSetting} />
            )}
            {activeTab === 'signatures' && (
              <SignatureTab aiProviders={aiProviders} />
            )}
            {activeTab === 'conversation' && (
              <ConversationTab aiProviders={aiProviders} />
            )}
            {activeTab === 'agent' && (
              <AgentTab aiProviders={aiProviders} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
