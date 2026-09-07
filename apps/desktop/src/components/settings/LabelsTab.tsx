import type { Label } from '@sarvinbox/core';
import { Loader2, Plus, Trash2, Pencil, Check, X, Tag as TagIcon } from 'lucide-react';
import { useState, useEffect } from 'react';

import { LABEL_COLORS } from '../../config/label-colors';
import { useEmailStore } from '../../store/email-store';
import { buildLabelTree, flattenLabelTree } from '../../utils/label-tree';
import { useConfirm } from '../ConfirmDialog';
import { LabelColorPicker } from '../LabelColorPicker';
import { NewLabelDialog } from '../NewLabelDialog';
import { Tooltip } from '../Tooltip';

export function LabelsTab() {
  const { confirm, confirmDialog } = useConfirm();
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState(LABEL_COLORS[0]);

  const load = async () => {
    setLoading(true);
    try {
      const res = await window.electronAPI.labels.list();
      if (res.success && res.data) setLabels(res.data);
      // Keep the shared store (sidebar, label menus, chips) in sync.
      void useEmailStore.getState().loadLabels();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const startEdit = (label: Label) => {
    setEditId(label.id);
    setEditName(label.name);
    setEditColor(label.color);
  };

  const saveEdit = async () => {
    if (!editId || !editName.trim()) return;
    const res = await window.electronAPI.labels.update(editId, { name: editName.trim(), color: editColor });
    if (res.success) {
      setEditId(null);
      await load();
    } else {
      setError(res.error || 'Could not update label');
    }
  };

  const handleDelete = async (label: Label) => {
    const ok = await confirm({
      title: 'Delete label',
      message: `Delete the label "${label.name}"? It will be removed from Settings; existing emails keep the tag until re-labeled.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    const res = await window.electronAPI.labels.delete(label.id);
    if (res.success) setLabels((prev) => prev.filter((l) => l.id !== label.id));
  };

  return (
    <div className="space-y-6">
      {confirmDialog}

      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">Labels</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Create labels to organize mail. Apply them from an open email, from the bulk actions bar, or
          automatically with a filter. Click a label in the sidebar to see everything tagged with it.
        </p>

        {/* Create — same popup used by the sidebar and the apply-label menu */}
        <div className="mb-4">
          <button
            onClick={() => setShowNew(true)}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 flex items-center gap-2"
          >
            <Plus className="h-4 w-4" /> New label
          </button>
          {error && <p className="text-xs text-destructive mt-2">{error}</p>}
        </div>

        {showNew && (
          <NewLabelDialog
            labels={labels}
            onClose={() => setShowNew(false)}
            onCreated={() => load()}
          />
        )}

        {/* List */}
        <div className="border border-border rounded-lg overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : labels.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <TagIcon className="h-8 w-8 mb-2" />
              <p className="text-sm">No labels yet</p>
              <p className="text-xs mt-1">Click "New label" to start organizing mail</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {flattenLabelTree(buildLabelTree(labels)).map(({ node, depth }) => {
                // Indent by depth (16px = the original px-4 left padding at depth 0)
                // and show only the leaf segment so nesting reads as a tree.
                const indentStyle = { paddingLeft: `${depth * 20 + 16}px` };
                // Container segment with no label of its own — a plain header row.
                if (!node.label) {
                  return (
                    <div key={node.path} className="flex items-center gap-2 py-3 pr-4 text-muted-foreground" style={indentStyle}>
                      <TagIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="text-sm truncate">{node.name}</span>
                    </div>
                  );
                }
                const label = node.label;
                return (
                  <div key={label.id} className="flex items-center justify-between py-3 pr-4 hover:bg-muted/30" style={indentStyle}>
                    {editId === label.id ? (
                      <>
                        <div className="flex items-center gap-3 flex-1 flex-wrap">
                          <input
                            type="text"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditId(null); }}
                            className="flex-1 min-w-[160px] px-3 py-1.5 border border-border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                            autoFocus
                          />
                          <LabelColorPicker value={editColor} onChange={setEditColor} initial={editName.trim().charAt(0).toUpperCase()} />
                        </div>
                        <div className="flex items-center gap-1 ml-3">
                          <Tooltip content="Save" delayMs={40}>
                            <button onClick={saveEdit} className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md" aria-label="Save label">
                              <Check className="h-4 w-4" />
                            </button>
                          </Tooltip>
                          <Tooltip content="Cancel" delayMs={40}>
                            <button onClick={() => setEditId(null)} className="p-2 text-muted-foreground hover:text-foreground rounded-md" aria-label="Cancel">
                              <X className="h-4 w-4" />
                            </button>
                          </Tooltip>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
                          <span className="text-sm font-medium truncate">{node.name}</span>
                        </div>
                        <div className="flex items-center gap-1 ml-3">
                          <Tooltip content="Edit" delayMs={40}>
                            <button onClick={() => startEdit(label)} className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md" aria-label="Edit label">
                              <Pencil className="h-4 w-4" />
                            </button>
                          </Tooltip>
                          <Tooltip content="Delete" delayMs={40}>
                            <button onClick={() => handleDelete(label)} className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md" aria-label="Delete label">
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </Tooltip>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
