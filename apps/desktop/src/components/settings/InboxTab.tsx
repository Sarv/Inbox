import { useState } from 'react';

import { type InboxType, type SectionFilter, type InboxSection, DEFAULT_SECTIONS, SECTION_FILTER_LABELS, SETTINGS_KEY } from '../../config/inbox-types';
import { useEmailStore } from '../../store/email-store';

import type { SettingsTabProps } from './types';

interface InboxTabProps extends SettingsTabProps {}

export function InboxTab({ settings, updateSetting }: InboxTabProps) {
  const [expandedSectionOptions, setExpandedSectionOptions] = useState<string | null>(null);

  // Get current sections (use saved or default based on inbox type)
  const getCurrentSections = (): InboxSection[] => {
    if (settings.inboxType === 'default') return [];
    if (settings.inboxSections && settings.inboxSections.length > 0) {
      return settings.inboxSections;
    }
    return DEFAULT_SECTIONS[settings.inboxType] || [];
  };

  const currentSections = getCurrentSections();

  // Handle inbox type change
  const handleInboxTypeChange = (newType: InboxType) => {
    const newSections = newType === 'default' ? [] : (DEFAULT_SECTIONS[newType] || []);
    updateSetting('inboxType', newType);
    // Reset sections to defaults for new type
    updateSetting('inboxSections', newSections);

    // Persist the choice immediately (merged into existing settings) and apply
    // it to the live inbox — so it survives a relaunch without needing the
    // separate "Save Changes" click. This is the setting users switch most.
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      const merged = { ...(stored ? JSON.parse(stored) : {}), inboxType: newType, inboxSections: newSections };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
      useEmailStore.getState().reloadInboxSettings();
    } catch (e) {
      console.error('Failed to persist inbox type:', e);
    }
  };

  // Handle section filter change
  const handleSectionFilterChange = (sectionId: string, newFilter: SectionFilter) => {
    const updated = currentSections.map(s =>
      s.id === sectionId ? { ...s, filter: newFilter } : s
    );
    updateSetting('inboxSections', updated);
  };

  // Handle section option change
  const handleSectionOptionChange = (sectionId: string, option: 'maxItems' | 'hideWhenEmpty', value: number | boolean) => {
    const updated = currentSections.map(s =>
      s.id === sectionId ? { ...s, [option]: value } : s
    );
    updateSetting('inboxSections', updated);
  };

  // Add a new section (max 4)
  const addSection = () => {
    if (currentSections.length >= 4) return;
    const newSection: InboxSection = {
      id: `section-${Date.now()}`,
      filter: 'unread',
      maxItems: 0,
      hideWhenEmpty: true,
    };
    updateSetting('inboxSections', [...currentSections, newSection]);
  };

  // Remove a section
  const removeSection = (sectionId: string) => {
    if (currentSections.length <= 1) return;
    updateSetting('inboxSections', currentSections.filter(s => s.id !== sectionId));
  };

  return (
    <div className="space-y-6">
      {/* Inbox Type */}
      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Inbox Type
        </h3>

        <div className="flex items-center justify-between py-3">
          <div>
            <div className="font-medium">Inbox type</div>
            <div className="text-sm text-muted-foreground">
              Choose how emails are organized in your inbox
            </div>
          </div>
          <select
            value={settings.inboxType}
            onChange={(e) => handleInboxTypeChange(e.target.value as InboxType)}
            className="px-3 py-1.5 bg-background border border-border rounded text-sm min-w-[180px]"
          >
            <option value="default">Default</option>
            <option value="important_first">Important first</option>
            <option value="unread_first">Unread first</option>
            <option value="priority_first">Priority Inbox</option>
          </select>
        </div>
      </div>

      {/* Inbox Sections (shown for non-default types) */}
      {settings.inboxType !== 'default' && currentSections.length > 0 && (
        <div className="border-b border-border pb-6">
          <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
            Inbox Sections
          </h3>

          <div className="space-y-3">
            {currentSections.map((section, index) => (
              <div key={section.id} className="flex items-center gap-3 py-2 group">
                <span className="text-sm text-muted-foreground w-6">{index + 1}.</span>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{SECTION_FILTER_LABELS[section.filter]}</span>
                  </div>
                </div>
                <div className="relative">
                  <button
                    onClick={() => setExpandedSectionOptions(
                      expandedSectionOptions === section.id ? null : section.id
                    )}
                    className="px-3 py-1 text-sm border border-border rounded hover:bg-accent transition-colors"
                  >
                    Options ▾
                  </button>

                  {/* Options Dropdown */}
                  {expandedSectionOptions === section.id && (
                    <div className="absolute right-0 top-full mt-1 w-72 bg-card border border-border rounded-lg shadow-xl z-50 p-4 space-y-4">
                      {/* Section Filter */}
                      <div>
                        <label className="block text-sm font-medium mb-2">Show</label>
                        <select
                          value={section.filter}
                          onChange={(e) => handleSectionFilterChange(section.id, e.target.value as SectionFilter)}
                          className="w-full px-3 py-1.5 bg-background border border-border rounded text-sm"
                        >
                          <option value="important_unread">Important and unread</option>
                          <option value="important">Important</option>
                          <option value="unread">Unread</option>
                          <option value="starred">Starred</option>
                          <option value="everything_else">Everything else</option>
                        </select>
                      </div>

                      {/* Max Items */}
                      <div>
                        <label className="block text-sm font-medium mb-2">Maximum items</label>
                        <select
                          value={section.maxItems}
                          onChange={(e) => handleSectionOptionChange(section.id, 'maxItems', Number(e.target.value))}
                          className="w-full px-3 py-1.5 bg-background border border-border rounded text-sm"
                        >
                          <option value={0}>No limit</option>
                          <option value={5}>5 items</option>
                          <option value={10}>10 items</option>
                          <option value={25}>25 items</option>
                          <option value={50}>50 items</option>
                        </select>
                      </div>

                      {/* Hide When Empty */}
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={section.hideWhenEmpty}
                          onChange={(e) => handleSectionOptionChange(section.id, 'hideWhenEmpty', e.target.checked)}
                          className="w-4 h-4 rounded"
                        />
                        <span className="text-sm">Hide section when empty</span>
                      </label>

                      {/* Remove Section */}
                      {currentSections.length > 1 && section.filter !== 'everything_else' && (
                        <button
                          onClick={() => {
                            removeSection(section.id);
                            setExpandedSectionOptions(null);
                          }}
                          className="w-full px-3 py-1.5 text-sm text-destructive border border-destructive/30 rounded hover:bg-destructive/10 transition-colors"
                        >
                          Remove section
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Add Section Button */}
            {currentSections.length < 4 && (
              <button
                onClick={addSection}
                className="text-sm text-primary hover:underline mt-2"
              >
                + Add another section
              </button>
            )}
          </div>

          <p className="text-sm text-muted-foreground mt-4">
            {settings.inboxType === 'important_first' && 'Emails marked as important or starred will appear in the first section.'}
            {settings.inboxType === 'unread_first' && 'Unread emails will appear in the first section of your inbox.'}
            {settings.inboxType === 'priority_first' && 'Customize which emails appear in each section. Priority Inbox learns what\'s important to you.'}
          </p>
        </div>
      )}

      {/* Importance Markers */}
      <div className="border-b border-border pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          Importance Markers
        </h3>

        <div className="space-y-3">
          <label className="flex items-start gap-3 cursor-pointer py-2">
            <input
              type="radio"
              checked={settings.showImportanceMarkers}
              onChange={() => updateSetting('showImportanceMarkers', true)}
              className="w-4 h-4 mt-0.5"
            />
            <div>
              <div className="font-medium">Show markers</div>
              <div className="text-sm text-muted-foreground">
                Show a marker ({'\u2605'}) by messages marked as important
              </div>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer py-2">
            <input
              type="radio"
              checked={!settings.showImportanceMarkers}
              onChange={() => updateSetting('showImportanceMarkers', false)}
              className="w-4 h-4 mt-0.5"
            />
            <div>
              <div className="font-medium">No markers</div>
              <div className="text-sm text-muted-foreground">
                Don't show importance markers
              </div>
            </div>
          </label>
        </div>

        <p className="text-sm text-muted-foreground mt-4">
          Sarv Inbox analyzes your incoming messages to predict what's important, considering things like how you've treated similar messages in the past and how directly the message is addressed to you.
        </p>
      </div>

      {/* About Inbox Types */}
      <div className="pb-6">
        <h3 className="text-sm font-semibold mb-4 text-muted-foreground uppercase tracking-wider">
          About Inbox Types
        </h3>
        <div className="space-y-4 text-sm">
          <div className="p-3 bg-muted/50 rounded-lg">
            <div className="font-medium mb-1">Default</div>
            <div className="text-muted-foreground">
              Emails are sorted by date, newest first. All emails appear in a single list.
            </div>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg">
            <div className="font-medium mb-1">Important first</div>
            <div className="text-muted-foreground">
              Important and starred emails appear at the top, followed by everything else.
            </div>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg">
            <div className="font-medium mb-1">Unread first</div>
            <div className="text-muted-foreground">
              Unread emails appear at the top, followed by read emails.
            </div>
          </div>
          <div className="p-3 bg-muted/50 rounded-lg">
            <div className="font-medium mb-1">Priority Inbox</div>
            <div className="text-muted-foreground">
              Fully customizable sections. Configure up to 4 sections with different filters like Important and unread, Starred, Unread, or Everything else.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
