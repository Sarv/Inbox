import type { FilterRule, FilterCondition, FilterAction, FilterField, FilterOperator, FilterActionType } from '@sarvinbox/core';
import { Loader2, Trash2, Plus, Pencil, X, Filter as FilterIcon, GripVertical } from 'lucide-react';
import { useState, useEffect } from 'react';

import { useEmailStore } from '../../store/email-store';
import { consumePendingFilterDraft } from '../../utils/filter-draft-bridge';
import { useConfirm } from '../ConfirmDialog';
import { Tooltip } from '../Tooltip';

import { BlockedSendersPanel } from './BlockedSendersPanel';

const FIELD_LABELS: Record<FilterField, string> = {
  from: 'From', to: 'To', cc: 'Cc', subject: 'Subject', body: 'Body', domain: 'Sender domain',
};
const OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: 'contains', notContains: 'does not contain', equals: 'equals', startsWith: 'starts with', endsWith: 'ends with',
};
const ACTION_LABELS: Record<FilterActionType, string> = {
  markRead: 'Mark as read', star: 'Star', archive: 'Archive', delete: 'Delete (move to Trash)',
  moveToSpam: 'Move to Spam', moveToFolder: 'Move to folder', applyLabel: 'Apply label',
};

const emptyCondition = (): FilterCondition => ({ field: 'from', operator: 'contains', value: '' });
const emptyAction = (): FilterAction => ({ type: 'markRead' });

interface DraftRule {
  id?: string;
  name: string;
  matchType: 'all' | 'any';
  conditions: FilterCondition[];
  actions: FilterAction[];
  stopProcessing: boolean;
  applyToExisting: boolean;
}

const emptyDraft = (): DraftRule => ({
  name: '', matchType: 'all', conditions: [emptyCondition()], actions: [emptyAction()], stopProcessing: false, applyToExisting: false,
});

const summarize = (rule: FilterRule): string => {
  const conds = rule.conditions
    .map(c => `${FIELD_LABELS[c.field]} ${OPERATOR_LABELS[c.operator]} "${c.value}"`)
    .join(rule.matchType === 'all' ? ' AND ' : ' OR ');
  const acts = rule.actions.map(a => ACTION_LABELS[a.type] + (a.value ? `: ${a.value}` : '')).join(', ');
  return `${conds || 'no conditions'} → ${acts || 'no actions'}`;
};

export function FiltersTab() {
  const [subTab, setSubTab] = useState<'filters' | 'blocked'>('filters');
  const { confirm, confirmDialog } = useConfirm();
  const folders = useEmailStore(s => s.folders);
  const labels = useEmailStore(s => s.labels);
  const [rules, setRules] = useState<FilterRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<DraftRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [countingMatches, setCountingMatches] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI.filters.list();
      if (res.success && res.data) setRules(res.data);
    } catch (error) {
      console.error('Failed to load filters:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // If we arrived here from "Create filter" in Advanced Search, open the form
  // pre-filled with the search criteria (the user just picks the actions + saves).
  useEffect(() => {
    const seed = consumePendingFilterDraft();
    if (!seed) return;
    setSubTab('filters');
    setDraft({
      ...emptyDraft(),
      name: seed.name,
      matchType: seed.matchType,
      conditions: seed.conditions.length ? seed.conditions : [emptyCondition()],
    });
  }, []);

  // Live preview of how many existing emails the draft would match. Runs while
  // "apply to existing" is ticked and refreshes (debounced) as conditions change.
  useEffect(() => {
    if (!draft || !draft.applyToExisting) { setMatchCount(null); return; }
    const valid = draft.conditions.filter(c => c.value.trim());
    if (valid.length === 0) { setMatchCount(null); return; }
    const matchType = draft.matchType;
    setCountingMatches(true);
    const t = window.setTimeout(async () => {
      try {
        const res = await window.electronAPI.filters.countMatches({ matchType, conditions: valid });
        setMatchCount(res.success ? (res.data?.count ?? 0) : null);
      } catch {
        setMatchCount(null);
      } finally {
        setCountingMatches(false);
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [draft?.applyToExisting, draft?.matchType, JSON.stringify(draft?.conditions)]);

  const saveDraft = async () => {
    if (!draft) return;
    const cleanConditions = draft.conditions.filter(c => c.value.trim());
    if (!draft.name.trim() || cleanConditions.length === 0 || draft.actions.length === 0) return;
    setSaving(true);
    const wantApply = draft.applyToExisting;
    try {
      const payload = {
        name: draft.name.trim(),
        matchType: draft.matchType,
        conditions: cleanConditions,
        actions: draft.actions,
        stopProcessing: draft.stopProcessing,
      };
      const res = draft.id
        ? await window.electronAPI.filters.update(draft.id, payload)
        : await window.electronAPI.filters.create(payload);
      if (res.success) {
        const ruleId = draft.id || (res.data ? res.data.id : null);
        setDraft(null);
        await load();
        if (wantApply && ruleId) {
          const applyRes = await window.electronAPI.filters.applyToExisting(ruleId);
          const n = applyRes.success ? (applyRes.data?.count ?? 0) : 0;
          setNotice(
            applyRes.success
              ? `Filter applied to ${n} existing email${n === 1 ? '' : 's'}.`
              : `Filter saved, but applying to existing emails failed: ${applyRes.error}`,
          );
          setTimeout(() => setNotice(null), 6000);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (rule: FilterRule) => {
    await window.electronAPI.filters.update(rule.id, { enabled: !rule.enabled });
    setRules(prev => prev.map(r => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)));
  };

  const deleteRule = async (rule: FilterRule) => {
    const ok = await confirm({
      title: 'Delete filter',
      message: `Delete the filter "${rule.name}"? This can't be undone.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await window.electronAPI.filters.delete(rule.id);
    setRules(prev => prev.filter(r => r.id !== rule.id));
  };

  const editRule = (rule: FilterRule) => {
    setDraft({
      id: rule.id,
      name: rule.name,
      matchType: rule.matchType,
      conditions: rule.conditions.length ? rule.conditions : [emptyCondition()],
      actions: rule.actions.length ? rule.actions : [emptyAction()],
      stopProcessing: rule.stopProcessing,
      applyToExisting: false,
    });
  };

  // Drag-to-reorder: the top rule is highest priority (runs first). On drop we
  // persist the new order; the backend reassigns priorities top-to-bottom.
  const handleDrop = async (dropIndex: number) => {
    const from = dragIndex;
    setDragIndex(null);
    if (from === null || from === dropIndex) return;
    const reordered = [...rules];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(dropIndex, 0, moved);
    setRules(reordered); // optimistic
    try {
      await window.electronAPI.filters.reorder(reordered.map(r => r.id));
    } catch (error) {
      console.error('Failed to reorder filters:', error);
      load(); // revert to server order on failure
    }
  };

  // Draft field mutators
  const patchCondition = (i: number, patch: Partial<FilterCondition>) =>
    setDraft(d => d && { ...d, conditions: d.conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) });
  const patchAction = (i: number, patch: Partial<FilterAction>) =>
    setDraft(d => d && { ...d, actions: d.actions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)) });

  return (
    <div>
      {confirmDialog}
      {/* Sub-tabs: Filters | Blocked (nested inside the one Settings tab) */}
      <div className="flex gap-1 border-b border-border mb-6">
        {([['filters', 'Filters'], ['blocked', 'Blocked']] as const).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setSubTab(id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              subTab === id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {subTab === 'blocked' ? (
        <BlockedSendersPanel />
      ) : (
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Filters{rules.length > 0 ? ` (${rules.length})` : ''}
          </h3>
          {!draft && (
            <button
              onClick={() => setDraft(emptyDraft())}
              className="text-xs px-3 py-1.5 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 flex items-center gap-1.5"
            >
              <Plus className="h-3 w-3" /> New filter
            </button>
          )}
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Automatically act on incoming mail. Rules run in priority order when a message arrives —
          <span className="font-medium"> #1 is highest (runs first)</span>, then #2, #3, and so on. Drag to reorder.
        </p>

        {notice && (
          <div className="mb-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-800 dark:bg-green-900/20 dark:text-green-200">
            {notice}
          </div>
        )}

        {/* Editor */}
        {draft && (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
            onClick={() => setDraft(null)}
          >
            <div
              className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-lg border border-border bg-background p-5 shadow-xl space-y-4"
              onClick={(e) => e.stopPropagation()}
            >
            <div className="flex items-center justify-between">
              <input
                type="text"
                placeholder="Filter name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="flex-1 px-3 py-2 border border-border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <Tooltip content="Cancel" delayMs={40}>
                <button onClick={() => setDraft(null)} className="ml-2 p-2 text-muted-foreground hover:text-foreground" aria-label="Cancel editing">
                  <X className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>

            {/* Match type */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Match</span>
              <select
                value={draft.matchType}
                onChange={(e) => setDraft({ ...draft, matchType: e.target.value as 'all' | 'any' })}
                className="px-2 py-1 border border-border rounded-md bg-background text-sm"
              >
                <option value="all">all conditions</option>
                <option value="any">any condition</option>
              </select>
            </div>

            {/* Conditions */}
            <div className="space-y-2">
              {draft.conditions.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select value={c.field} onChange={(e) => patchCondition(i, { field: e.target.value as FilterField })}
                    className="px-2 py-1.5 border border-border rounded-md bg-background text-sm">
                    {(Object.keys(FIELD_LABELS) as FilterField[]).map(f => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}
                  </select>
                  <select value={c.operator} onChange={(e) => patchCondition(i, { operator: e.target.value as FilterOperator })}
                    className="px-2 py-1.5 border border-border rounded-md bg-background text-sm">
                    {(Object.keys(OPERATOR_LABELS) as FilterOperator[]).map(o => <option key={o} value={o}>{OPERATOR_LABELS[o]}</option>)}
                  </select>
                  <input type="text" placeholder="value" value={c.value} onChange={(e) => patchCondition(i, { value: e.target.value })}
                    className="flex-1 px-3 py-1.5 border border-border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
                  <Tooltip content="Remove condition" delayMs={40}>
                    <button
                      onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, idx) => idx !== i) })}
                      disabled={draft.conditions.length === 1}
                      className="p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-30"
                      aria-label="Remove condition"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                </div>
              ))}
              <button onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, emptyCondition()] })}
                className="text-xs text-primary hover:underline flex items-center gap-1">
                <Plus className="h-3 w-3" /> Add condition
              </button>
            </div>

            {/* Actions */}
            <div className="space-y-2 border-t border-border pt-3">
              <span className="text-xs text-muted-foreground uppercase tracking-wider">Then</span>
              {draft.actions.map((a, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select value={a.type} onChange={(e) => patchAction(i, { type: e.target.value as FilterActionType, value: undefined })}
                    className="px-2 py-1.5 border border-border rounded-md bg-background text-sm">
                    {(Object.keys(ACTION_LABELS) as FilterActionType[]).map(t => <option key={t} value={t}>{ACTION_LABELS[t]}</option>)}
                  </select>
                  {a.type === 'moveToFolder' && (
                    <select value={a.value ?? ''} onChange={(e) => patchAction(i, { value: e.target.value })}
                      className="flex-1 px-2 py-1.5 border border-border rounded-md bg-background text-sm">
                      <option value="">Select folder…</option>
                      {folders.map(f => <option key={f.id} value={f.path}>{f.path}</option>)}
                    </select>
                  )}
                  {a.type === 'applyLabel' && (
                    labels.length > 0 ? (
                      <select value={a.value ?? ''} onChange={(e) => patchAction(i, { value: e.target.value })}
                        className="flex-1 px-2 py-1.5 border border-border rounded-md bg-background text-sm">
                        <option value="">Select label…</option>
                        {labels.map(l => <option key={l.id} value={l.name}>{l.name}</option>)}
                      </select>
                    ) : (
                      <span className="flex-1 text-xs text-muted-foreground px-1">No labels yet — create one in Settings → Labels.</span>
                    )
                  )}
                  <Tooltip content="Remove action" delayMs={40}>
                    <button
                      onClick={() => setDraft({ ...draft, actions: draft.actions.filter((_, idx) => idx !== i) })}
                      disabled={draft.actions.length === 1}
                      className="p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-30"
                      aria-label="Remove action"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                </div>
              ))}
              <button onClick={() => setDraft({ ...draft, actions: [...draft.actions, emptyAction()] })}
                className="text-xs text-primary hover:underline flex items-center gap-1">
                <Plus className="h-3 w-3" /> Add action
              </button>
            </div>

            <div className="flex items-end justify-between gap-4 border-t border-border pt-3">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={draft.stopProcessing} onChange={(e) => setDraft({ ...draft, stopProcessing: e.target.checked })} />
                  Stop processing further filters if this matches
                </label>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <input type="checkbox" checked={draft.applyToExisting} onChange={(e) => setDraft({ ...draft, applyToExisting: e.target.checked })} />
                  Also apply to matching existing emails
                  {draft.applyToExisting && (
                    <span className="text-xs text-muted-foreground/80">
                      {countingMatches
                        ? '(counting…)'
                        : matchCount != null
                          ? `(${matchCount} matching)`
                          : ''}
                    </span>
                  )}
                </label>
              </div>
              <button
                onClick={saveDraft}
                disabled={saving || !draft.name.trim() || !draft.conditions.some(c => c.value.trim())}
                className="shrink-0 px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 flex items-center gap-2"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {draft.id ? 'Save filter' : 'Create filter'}
              </button>
            </div>
            </div>
          </div>
        )}

        {/* Rules list */}
        <div className="border border-border rounded-lg overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : rules.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <FilterIcon className="h-8 w-8 mb-2" />
              <p className="text-sm">No filters yet</p>
              <p className="text-xs mt-1">Create a filter to automatically sort incoming mail</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {rules.map((rule, i) => (
                <div
                  key={rule.id}
                  draggable={rules.length > 1}
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(i)}
                  onDragEnd={() => setDragIndex(null)}
                  className={`flex items-center justify-between px-4 py-3 hover:bg-muted/30 ${dragIndex === i ? 'opacity-50' : ''}`}
                >
                  {rules.length > 1 && (
                    <Tooltip content="Drag to change priority" delayMs={40}>
                      <span className="mr-1 cursor-grab text-muted-foreground/60 hover:text-muted-foreground active:cursor-grabbing" aria-label="Drag to reorder">
                        <GripVertical className="h-4 w-4" />
                      </span>
                    </Tooltip>
                  )}
                  <Tooltip content={i === 0 ? 'Highest priority — runs first' : `Priority ${i + 1}`} delayMs={40}>
                    <span className="mr-3 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground" aria-label={`Priority ${i + 1}`}>
                      {i + 1}
                    </span>
                  </Tooltip>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm truncate">{rule.name}</span>
                      {!rule.enabled && <span className="text-xs text-muted-foreground">(disabled)</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 truncate" title={summarize(rule)}>{summarize(rule)}</p>
                  </div>
                  <div className="flex items-center gap-1 ml-4">
                    <Tooltip content={rule.enabled ? 'Disable' : 'Enable'} delayMs={40}>
                      <button onClick={() => toggleRule(rule)} className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors" aria-label={rule.enabled ? 'Disable filter' : 'Enable filter'}
                        style={{ backgroundColor: rule.enabled ? 'var(--primary, #2563eb)' : 'var(--muted, #cbd5e1)' }}>
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${rule.enabled ? 'translate-x-4' : 'translate-x-1'}`} />
                      </button>
                    </Tooltip>
                    <Tooltip content="Edit" delayMs={40}>
                      <button onClick={() => editRule(rule)} className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md" aria-label="Edit filter">
                        <Pencil className="h-4 w-4" />
                      </button>
                    </Tooltip>
                    <Tooltip content="Delete" delayMs={40}>
                      <button onClick={() => deleteRule(rule)} className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md" aria-label="Delete filter">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </Tooltip>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
