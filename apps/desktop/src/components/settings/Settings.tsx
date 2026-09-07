import { Save } from 'lucide-react';
import { useState, useEffect } from 'react';

import { SETTINGS_KEY } from '../../config/inbox-types';
import { useEmailStore } from '../../store/email-store';
import { migrateSignatures } from '../../utils/signatures';

import { AccountsTab } from './AccountsTab';
import { AdvancedTab } from './AdvancedTab';
import { FiltersTab } from './FiltersTab';
import { FoldersTab } from './FoldersTab';
import { GeneralTab } from './GeneralTab';
import { InboxTab } from './InboxTab';
import { KeyboardShortcutsTab } from './KeyboardShortcutsTab';
import { type SettingsTab, type AppSettings, defaultSettings } from './types';

const tabs: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'accounts', label: 'Accounts and Import' },
  { id: 'folders', label: 'Folders' },
  { id: 'filters', label: 'Filters and Blocked' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'keyboard-shortcuts', label: 'Keyboard Shortcuts' },
];

export function Settings({ initialTab, openAddAccount, onAddAccountConsumed, onDirtyChange }: { initialTab?: SettingsTab; openAddAccount?: boolean; onAddAccountConsumed?: () => void; onDirtyChange?: (dirty: boolean) => void } = {}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'general');
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [hasChanges, setHasChanges] = useState(false);
  const [saved, setSaved] = useState(false);

  // Report unsaved-changes state up so navigating away can prompt to discard.
  // Reset to "clean" on unmount — a torn-down Settings screen has nothing to save.
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
        // Legacy → new: the old boolean `autoLoadRemoteImages` becomes the
        // 3-way `remoteImageMode`, so an existing user KEEPS their choice
        // (always/block) instead of being flipped to the new 'safe' default that
        // a fresh install gets. Kept in sync with getRemoteImageMode.
        if (parsed.remoteImageMode === undefined && typeof parsed.autoLoadRemoteImages === 'boolean') {
          parsed.remoteImageMode = parsed.autoLoadRemoteImages ? 'always' : 'block';
        }
        // The old 'important' (auto-load only AI-Important mail) is superseded by
        // 'safe' (auto-load all except Promotional/Spam).
        if (parsed.remoteImageMode === 'important') {
          parsed.remoteImageMode = 'safe';
        }
        const merged = { ...defaultSettings, ...parsed };
        // Migrate a legacy single `signature` string into the multi-signature list.
        setSettings({ ...merged, ...migrateSignatures(merged) });
      } catch (e) {
        console.error('Failed to parse settings:', e);
      }
    }
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

    // Update Zustand store inbox settings
    useEmailStore.getState().reloadInboxSettings();

    // Push profile fields to the main-process pipeline so the AI reply
    // drafter can personalise drafts ("I will…" as the real user, not a
    // generic assistant).
    window.electronAPI?.agent?.setConfig?.({
      userName: settings.profileName || '',
      profileTitle: settings.profileTitle || '',
      profileCompany: settings.profileCompany || '',
    } as any).catch(() => {});

    // Push new-mail notification prefs to the main-process service (it owns the
    // firing). Partial config — accounts/current-view are pushed by the bridge.
    (window.electronAPI as any)?.notifications?.setConfig?.({
      mode: settings.desktopNotifications,
      sound: settings.notificationSound,
      workingHours: settings.notificationWorkingHours,
    }).catch(() => {});
  };

  return (
    <div className="flex-1 h-full overflow-hidden bg-background">
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Settings</h1>
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
          <div className="max-w-3xl">
            {activeTab === 'general' && <GeneralTab settings={settings} updateSetting={updateSetting} />}
            {activeTab === 'inbox' && <InboxTab settings={settings} updateSetting={updateSetting} />}
            {activeTab === 'accounts' && <AccountsTab settings={settings} updateSetting={updateSetting} openAddAccount={openAddAccount} onAddAccountConsumed={onAddAccountConsumed} />}
            {activeTab === 'folders' && <FoldersTab />}
            {activeTab === 'filters' && <FiltersTab />}
            {activeTab === 'advanced' && <AdvancedTab />}
            {activeTab === 'keyboard-shortcuts' && <KeyboardShortcutsTab settings={settings} updateSetting={updateSetting} />}
          </div>
        </div>
      </div>
    </div>
  );
}
