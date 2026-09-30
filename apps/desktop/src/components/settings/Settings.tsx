import { Save } from 'lucide-react';
import { useState, useEffect } from 'react';

import { useEmailStore } from '../../store/email-store';
import { readAppSettings, saveSettingsFromScreen } from '../../utils/app-settings';
import { migrateSignatures } from '../../utils/signatures';

import { AccountsTab } from './AccountsTab';
import { AdvancedTab } from './AdvancedTab';
import { AppearanceTab } from './AppearanceTab';
import { EncryptionTab } from './EncryptionTab';
import { FiltersTab } from './FiltersTab';
import { FoldersTab } from './FoldersTab';
import { GeneralTab } from './GeneralTab';
import { InboxTab } from './InboxTab';
import { KeyboardShortcutsTab } from './KeyboardShortcutsTab';
import { settingsContentWidthClass } from './settings-layout';
import { type SettingsTab, type AppSettings, defaultSettings } from './types';

const tabs: { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'accounts', label: 'Accounts and Import' },
  { id: 'folders', label: 'Folders' },
  { id: 'filters', label: 'Filters and Blocked' },
  { id: 'encryption', label: 'Encryption' },
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

  // Load settings from localStorage. The remote-image mode is not this
  // screen's (Security → Remote images owns it, and reads legacy values
  // itself); Save leaves it as stored — see saveSettingsFromScreen.
  useEffect(() => {
    const merged = readAppSettings();
    // Migrate a legacy single `signature` string into the multi-signature list.
    setSettings({ ...merged, ...migrateSignatures(merged) });
  }, []);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
    setSaved(false);
  };

  const saveSettings = () => {
    saveSettingsFromScreen(settings);
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
          <div className={settingsContentWidthClass(activeTab)}>
            {activeTab === 'general' && <GeneralTab settings={settings} updateSetting={updateSetting} />}
            {activeTab === 'appearance' && <AppearanceTab />}
            {activeTab === 'inbox' && <InboxTab settings={settings} updateSetting={updateSetting} />}
            {activeTab === 'accounts' && <AccountsTab settings={settings} updateSetting={updateSetting} openAddAccount={openAddAccount} onAddAccountConsumed={onAddAccountConsumed} />}
            {activeTab === 'folders' && <FoldersTab />}
            {activeTab === 'filters' && <FiltersTab />}
            {activeTab === 'encryption' && <EncryptionTab settings={settings} updateSetting={updateSetting} />}
            {activeTab === 'advanced' && <AdvancedTab />}
            {activeTab === 'keyboard-shortcuts' && <KeyboardShortcutsTab settings={settings} updateSetting={updateSetting} />}
          </div>
        </div>
      </div>
    </div>
  );
}
