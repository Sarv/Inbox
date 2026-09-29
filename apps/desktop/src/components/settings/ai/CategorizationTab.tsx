import { Save, Loader2, X, Trash2, Plus, Pencil, Sparkles, AlertCircle, Lock } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

import { isAIAssistEnabled } from '../../../services/agent-settings';
import { AIProvider } from '../../../services/ai-service';
import { ICON_MAP, COLOR_MAP } from '../../aibox/types';
import type { AppSettings } from '../types';

// Types for dynamic category definitions
interface CategoryDefinition {
  slug: string;
  name: string;
  description: string | null;
  prompt: string;
  icon: string;
  color: string;
  sortOrder: number;
  isSystem: boolean;
  isEnabled: boolean;
}

const AVAILABLE_ICONS = Object.keys(ICON_MAP).filter(k => k !== 'LayoutDashboard');
const AVAILABLE_COLORS = ['blue', 'red', 'green', 'yellow', 'orange', 'purple', 'cyan', 'pink'];

const COLOR_DOT_MAP: Record<string, string> = {
  blue: 'bg-blue-500',
  red: 'bg-red-500',
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  orange: 'bg-orange-500',
  purple: 'bg-purple-500',
  cyan: 'bg-cyan-500',
  pink: 'bg-pink-500',
};

interface CategorizationTabProps {
  aiProviders: AIProvider[];
  settings: AppSettings;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  /** Switch AI Settings to the Email Agent tab, where the AI Assist switch lives. */
  onOpenAgentTab?: () => void;
}

export function CategorizationTab({ aiProviders, settings, updateSetting, onOpenAgentTab }: CategorizationTabProps) {
  // There is deliberately NO on/off switch here. Automatic sorting is one LLM
  // call per new email in the main-process pipeline, and AI Assist (Email Agent
  // tab) is the only thing that gates it. This tab used to carry its own "Smart
  // Email Categorization" switch that the pipeline never read, so switching it
  // off stopped nothing while mail kept going to the AI provider. Show the real
  // state instead, and send the user to the real switch.
  const [aiAssistOn] = useState(isAIAssistEnabled);
  const hasProvider = aiProviders.length > 0;
  const sortingOn = hasProvider && aiAssistOn;
  // Dynamic category definitions state
  const [categoryDefs, setCategoryDefs] = useState<CategoryDefinition[]>([]);
  const [loadingCategoryDefs, setLoadingCategoryDefs] = useState(false);
  const [expandedCategorySlug, setExpandedCategorySlug] = useState<string | null>(null);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [newCategory, setNewCategory] = useState<Partial<CategoryDefinition>>({
    name: '', slug: '', description: '', prompt: '', icon: 'Tag', color: 'blue',
  });

  // Load category definitions on mount
  const loadCategoryDefs = useCallback(async () => {
    setLoadingCategoryDefs(true);
    try {
      const result = await window.electronAPI?.ai?.getCategoryDefinitions();
      if (result?.success && result.data) {
        setCategoryDefs(result.data);
      }
    } catch (e) {
      console.error('Failed to load category definitions:', e);
    } finally {
      setLoadingCategoryDefs(false);
    }
  }, []);

  useEffect(() => {
    loadCategoryDefs();
  }, [loadCategoryDefs]);

  // Category management handlers
  const handleToggleCategory = async (slug: string, enabled: boolean) => {
    try {
      await window.electronAPI.ai.toggleCategoryDefinition(slug, enabled);
      setCategoryDefs(prev => prev.map(d => d.slug === slug ? { ...d, isEnabled: enabled } : d));
    } catch (e) {
      console.error('Failed to toggle category:', e);
    }
  };

  const handleDeleteCategory = async (slug: string) => {
    if (!confirm('Delete this category? Existing email assignments will be removed.')) return;
    try {
      await window.electronAPI.ai.deleteCategoryDefinition(slug);
      setCategoryDefs(prev => prev.filter(d => d.slug !== slug));
      if (expandedCategorySlug === slug) setExpandedCategorySlug(null);
    } catch (e) {
      console.error('Failed to delete category:', e);
    }
  };

  const handleSaveCategoryPrompt = async (slug: string, prompt: string) => {
    const def = categoryDefs.find(d => d.slug === slug);
    if (!def) return;
    try {
      await window.electronAPI.ai.upsertCategoryDefinition({ ...def, prompt });
      setCategoryDefs(prev => prev.map(d => d.slug === slug ? { ...d, prompt } : d));
    } catch (e) {
      console.error('Failed to save category prompt:', e);
    }
  };

  const handleAddCategory = async () => {
    const slug = newCategory.slug || newCategory.name?.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || '';
    if (!slug || !newCategory.name || !newCategory.prompt) return;
    try {
      const def = {
        slug,
        name: newCategory.name,
        description: newCategory.description || null,
        prompt: newCategory.prompt,
        icon: newCategory.icon || 'Tag',
        color: newCategory.color || 'blue',
        sortOrder: categoryDefs.length + 1,
        isSystem: false,
        isEnabled: true,
      };
      await window.electronAPI.ai.upsertCategoryDefinition(def);
      setCategoryDefs(prev => [...prev, def]);
      setShowAddCategory(false);
      setNewCategory({ name: '', slug: '', description: '', prompt: '', icon: 'Tag', color: 'blue' });
    } catch (e) {
      console.error('Failed to add category:', e);
    }
  };

  return (
    <div className="space-y-6">
      {/* Automatic sorting status — read-only; AI Assist is the switch */}
      <div
        data-testid="auto-sorting-status"
        className={`rounded-lg border p-4 ${sortingOn ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/30'}`}
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Sparkles className={`h-5 w-5 flex-shrink-0 ${sortingOn ? 'text-primary' : 'text-muted-foreground'}`} />
            <div className="min-w-0">
              <div className="font-medium flex items-center gap-2">
                Automatic sorting
                {sortingOn ? (
                  <span className="text-xs px-2 py-0.5 bg-green-500/20 text-green-600 dark:text-green-400 rounded-full">On</span>
                ) : (
                  <span className="text-xs px-2 py-0.5 bg-muted text-muted-foreground rounded-full">Off</span>
                )}
              </div>
              <div className="text-sm text-muted-foreground">
                {!hasProvider
                  ? 'No AI provider is connected, so new mail is not sent anywhere for sorting.'
                  : aiAssistOn
                    ? 'New mail is sent to your AI provider and sorted into the categories below as it arrives. AI Assist controls this: turn it off in Email Agent to stop.'
                    : 'AI Assist is off, so new mail is not sent to your AI provider for sorting. Turn it on in Email Agent.'}
              </div>
            </div>
          </div>
          {hasProvider && onOpenAgentTab && (
            <button
              type="button"
              onClick={onOpenAgentTab}
              className="flex-shrink-0 text-sm px-3 py-1.5 border border-border rounded-md hover:bg-accent transition-colors"
            >
              Open Email Agent
            </button>
          )}
        </div>
      </div>

      <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
        <div className="flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
          <div className="text-sm">
            <p className="font-medium text-blue-600 dark:text-blue-400">How categorization works</p>
            <p className="text-muted-foreground mt-1">
              Each category below has its own prompt sent to the AI. Emails can match multiple categories or none.
              Disable categories to exclude them from processing. Add custom categories for your specific needs.
            </p>
          </div>
        </div>
      </div>

      {/* Category List */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <label className="text-sm font-medium">Categories</label>
          <button
            onClick={() => setShowAddCategory(true)}
            className="flex items-center gap-1 text-xs px-2 py-1 bg-primary text-primary-foreground hover:bg-primary/90 rounded transition-colors"
          >
            <Plus className="h-3 w-3" />
            Add Category
          </button>
        </div>

        {loadingCategoryDefs ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-2">
            {categoryDefs.map((cat) => {
              const isCatExpanded = expandedCategorySlug === cat.slug;
              return (
                <div key={cat.slug} className={`rounded-lg border ${cat.isEnabled ? 'border-border' : 'border-border/50 opacity-60'}`}>
                  {/* Category header */}
                  <div className="flex items-center gap-3 p-3">
                    {(() => {
                      const CatIcon = ICON_MAP[cat.icon] || ICON_MAP.Tag;
                      const catColor = COLOR_MAP[cat.color] || COLOR_MAP.blue;
                      return (
                        <div className={`p-1.5 rounded-md flex-shrink-0 ${catColor.bg}`}>
                          <CatIcon className={`h-3.5 w-3.5 ${catColor.text}`} />
                        </div>
                      );
                    })()}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{cat.name}</span>
                        <span className="text-xs text-muted-foreground font-mono">{cat.slug}</span>
                        {cat.isSystem && <span title="System category"><Lock className="h-3 w-3 text-muted-foreground" /></span>}
                      </div>
                      {cat.description && (
                        <div className="text-xs text-muted-foreground mt-0.5">{cat.description}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button
                        onClick={() => setExpandedCategorySlug(isCatExpanded ? null : cat.slug)}
                        className="p-1.5 hover:bg-accent rounded transition-colors"
                        title="Edit prompt"
                      >
                        <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                      </button>
                      {!cat.isSystem && (
                        <button
                          onClick={() => handleDeleteCategory(cat.slug)}
                          className="p-1.5 hover:bg-destructive/10 rounded transition-colors"
                          title="Delete category"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </button>
                      )}
                      <label className="relative inline-flex items-center cursor-pointer ml-1">
                        <input
                          type="checkbox"
                          checked={cat.isEnabled}
                          onChange={() => handleToggleCategory(cat.slug, !cat.isEnabled)}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-muted peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-ring rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-primary"></div>
                      </label>
                    </div>
                  </div>

                  {/* Expanded prompt editor */}
                  {isCatExpanded && (
                    <div className="border-t border-border p-3 space-y-2">
                      <textarea
                        value={cat.prompt}
                        onChange={(e) => setCategoryDefs(prev => prev.map(d => d.slug === cat.slug ? { ...d, prompt: e.target.value } : d))}
                        className="w-full px-3 py-2 bg-background border border-input rounded-md text-xs font-mono min-h-[120px] focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                        placeholder="Enter the AI prompt for this category..."
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleSaveCategoryPrompt(cat.slug, cat.prompt)}
                          className="flex items-center gap-1 text-xs px-2 py-1 bg-primary text-primary-foreground hover:bg-primary/90 rounded transition-colors"
                        >
                          <Save className="h-3 w-3" />
                          Save Prompt
                        </button>
                        <button
                          onClick={() => setExpandedCategorySlug(null)}
                          className="text-xs px-2 py-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Category Modal */}
      {showAddCategory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setShowAddCategory(false); setNewCategory({ name: '', slug: '', description: '', prompt: '', icon: 'Tag', color: 'blue' }); }}>
          <div className="bg-background border border-border rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <h3 className="text-base font-semibold">Add Custom Category</h3>
              <button
                onClick={() => { setShowAddCategory(false); setNewCategory({ name: '', slug: '', description: '', prompt: '', icon: 'Tag', color: 'blue' }); }}
                className="p-1.5 hover:bg-accent rounded-lg transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Modal body */}
            <div className="px-5 py-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Name</label>
                  <input
                    type="text"
                    value={newCategory.name || ''}
                    onChange={(e) => {
                      const name = e.target.value;
                      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
                      setNewCategory(prev => ({ ...prev, name, slug }));
                    }}
                    placeholder="e.g. Travel"
                    className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Slug</label>
                  <input
                    type="text"
                    value={newCategory.slug || ''}
                    onChange={(e) => setNewCategory(prev => ({ ...prev, slug: e.target.value }))}
                    placeholder="travel"
                    className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Description</label>
                <input
                  type="text"
                  value={newCategory.description || ''}
                  onChange={(e) => setNewCategory(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Short description..."
                  className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">AI Prompt</label>
                <textarea
                  value={newCategory.prompt || ''}
                  onChange={(e) => setNewCategory(prev => ({ ...prev, prompt: e.target.value }))}
                  placeholder="Instructions for the AI to determine if an email belongs to this category..."
                  className="w-full px-3 py-2 bg-background border border-input rounded-lg text-xs font-mono min-h-[100px] resize-y focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>

              {/* Icon picker */}
              <div>
                <label className="block text-xs font-medium mb-2">Icon</label>
                <div className="flex flex-wrap gap-1.5">
                  {AVAILABLE_ICONS.map(iconName => {
                    const IconComp = ICON_MAP[iconName];
                    if (!IconComp) return null;
                    const selected = (newCategory.icon || 'Tag') === iconName;
                    return (
                      <button
                        key={iconName}
                        type="button"
                        onClick={() => setNewCategory(prev => ({ ...prev, icon: iconName }))}
                        className={`p-2 rounded-lg border transition-colors ${
                          selected
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-transparent hover:bg-accent text-muted-foreground hover:text-foreground'
                        }`}
                        title={iconName}
                      >
                        <IconComp className="h-4 w-4" />
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Color picker */}
              <div>
                <label className="block text-xs font-medium mb-2">Color</label>
                <div className="flex flex-wrap gap-2">
                  {AVAILABLE_COLORS.map(color => {
                    const selected = (newCategory.color || 'blue') === color;
                    return (
                      <button
                        key={color}
                        type="button"
                        onClick={() => setNewCategory(prev => ({ ...prev, color }))}
                        className={`w-8 h-8 rounded-full border-2 transition-all ${COLOR_DOT_MAP[color] || 'bg-gray-500'} ${
                          selected ? 'border-foreground scale-110 ring-2 ring-ring ring-offset-2 ring-offset-background' : 'border-transparent hover:scale-105'
                        }`}
                        title={color}
                      />
                    );
                  })}
                </div>
              </div>

              {/* Preview */}
              {newCategory.name && (() => {
                const PreviewIcon = ICON_MAP[newCategory.icon || 'Tag'] || ICON_MAP.Tag;
                const previewColor = COLOR_MAP[newCategory.color || 'blue'] || COLOR_MAP.blue;
                return (
                  <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-muted/30">
                    <div className={`p-2 rounded-lg ${previewColor.bg}`}>
                      <PreviewIcon className={`h-5 w-5 ${previewColor.text}`} />
                    </div>
                    <div>
                      <div className="text-sm font-medium">{newCategory.name}</div>
                      {newCategory.description && <div className="text-xs text-muted-foreground">{newCategory.description}</div>}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
              <button
                onClick={() => { setShowAddCategory(false); setNewCategory({ name: '', slug: '', description: '', prompt: '', icon: 'Tag', color: 'blue' }); }}
                className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAddCategory}
                disabled={!newCategory.name || !newCategory.prompt}
                className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
              >
                Add Category
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Processing Limit */}
      <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
        <div>
          <div className="font-medium">AI Processing Limit</div>
          <div className="text-sm text-muted-foreground">
            Maximum latest unread emails to process per run
          </div>
        </div>
        <select
          value={settings.maxAIProcessingEmails}
          onChange={(e) => updateSetting('maxAIProcessingEmails', Number(e.target.value))}
          className="px-3 py-1.5 bg-background border border-border rounded text-sm"
        >
          <option value={100}>100</option>
          <option value={250}>250</option>
          <option value={500}>500</option>
          <option value={1000}>1,000</option>
          <option value={2500}>2,500</option>
          <option value={5000}>5,000</option>
          <option value={10000}>All (10,000+)</option>
        </select>
      </div>

      {aiProviders.length === 0 && (
        <div className="p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm">
          <div className="font-medium text-yellow-600 dark:text-yellow-400">No AI Provider Configured</div>
          <div className="text-muted-foreground mt-1">
            Add an AI provider in the Providers tab to enable categorization.
          </div>
        </div>
      )}
    </div>
  );
}
