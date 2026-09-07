import type { Label } from '@sarvinbox/core';
import { ChevronRight, ChevronDown, MoreVertical, Plus, Trash2, Pencil, Tag as TagIcon } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

import { LABEL_COLORS } from '../config/label-colors';
import { useEmailStore } from '../store/email-store';
import { buildLabelTree, type LabelNode } from '../utils/label-tree';

import { useConfirm } from './ConfirmDialog';
import { NewLabelDialog } from './NewLabelDialog';
import { Tooltip } from './Tooltip';

export function SidebarLabels() {
  const { confirm, confirmDialog } = useConfirm();
  const labels = useEmailStore((s) => s.labels);
  const showLabel = useEmailStore((s) => s.showLabel);
  const loadLabels = useEmailStore((s) => s.loadLabels);
  const selectedVirtualFolder = useEmailStore((s) => s.selectedVirtualFolder);

  const [expanded, setExpanded] = useState(true);
  const [openNodes, setOpenNodes] = useState<Set<string>>(new Set());
  const [menuPath, setMenuPath] = useState<string | null>(null); // ⋮ menu open for this path
  const [colorMenu, setColorMenu] = useState(false); // color submenu inside ⋮
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  // New-label dialog target: null = closed, '' = top-level, path = sublabel parent.
  const [createParent, setCreateParent] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuPath) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuPath(null);
        setColorMenu(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuPath]);

  const tree = buildLabelTree(labels);

  const toggleOpen = (path: string) =>
    setOpenNodes((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const setColor = async (label: Label, color: string) => {
    await window.electronAPI.labels.update(label.id, { color });
    setMenuPath(null);
    setColorMenu(false);
    await loadLabels();
  };

  const saveRename = async (label: Label) => {
    const name = editName.trim();
    setEditId(null);
    if (!name || name === label.name) return;
    // Preserve the parent path so an inline rename edits only the leaf segment.
    const parent = label.name.includes('/') ? label.name.slice(0, label.name.lastIndexOf('/') + 1) : '';
    await window.electronAPI.labels.update(label.id, { name: parent + name });
    await loadLabels();
  };

  const remove = async (label: Label) => {
    setMenuPath(null);
    const ok = await confirm({
      title: 'Delete label',
      message: `Delete "${label.name}"? Existing emails keep the tag until re-labeled.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    await window.electronAPI.labels.delete(label.id);
    await loadLabels();
  };

  const renderNode = (node: LabelNode, depth: number): JSX.Element => {
    const isOpen = openNodes.has(node.path);
    const hasChildren = node.children.length > 0;
    const active = selectedVirtualFolder === `label:${node.label?.name}`;
    return (
      <div key={node.path}>
        <div
          className={`group flex items-center gap-1 rounded-md text-foreground ${active ? 'bg-accent' : 'hover:bg-accent/50'}`}
          style={{ paddingLeft: `${depth * 12}px` }}
        >
          {hasChildren ? (
            <button onClick={() => toggleOpen(node.path)} className="p-1 text-muted-foreground hover:text-foreground" aria-label={isOpen ? 'Collapse' : 'Expand'}>
              {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : (
            <span className="w-5" />
          )}
          <button
            onClick={() => (node.label ? showLabel(node.label.name) : toggleOpen(node.path))}
            className="flex items-center gap-2 flex-1 min-w-0 py-2 text-left"
          >
            {node.label ? (
              <span className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: node.label.color }} />
            ) : (
              <TagIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="text-sm truncate">{node.name}</span>
          </button>
          {node.label && (
            <div className="relative pr-1">
              <button
                onClick={() => { setMenuPath(menuPath === node.path ? null : node.path); setColorMenu(false); }}
                className="p-1 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground hover:bg-muted/50"
                aria-label="Label options"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
              {menuPath === node.path && (
                <div ref={menuRef} className="absolute right-0 z-50 mt-1 w-48 rounded-md border border-border bg-background shadow-lg p-1 text-sm">
                  <button onClick={() => setColorMenu((c) => !c)} className="w-full flex items-center justify-between px-2 py-1.5 rounded hover:bg-muted/50">
                    <span className="flex items-center gap-2"><span className="h-3 w-3 rounded-full" style={{ backgroundColor: node.label.color }} /> Label color</span>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  {colorMenu && (
                    <div className="flex flex-wrap gap-1.5 px-2 py-2">
                      {LABEL_COLORS.map((c) => (
                        <button key={c} onClick={() => setColor(node.label!, c)} aria-label={`Color ${c}`}
                          className={`h-5 w-5 rounded-full ${node.label!.color === c ? 'ring-2 ring-offset-1 ring-foreground/40' : ''}`}
                          style={{ backgroundColor: c }} />
                      ))}
                    </div>
                  )}
                  <button onClick={() => { setEditId(node.label!.id); setEditName(node.name); setMenuPath(null); }} className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50">
                    <Pencil className="h-3.5 w-3.5" /> Rename
                  </button>
                  <button onClick={() => { setCreateParent(node.path); setMenuPath(null); }} className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50">
                    <Plus className="h-3.5 w-3.5" /> Add sublabel
                  </button>
                  <button onClick={() => remove(node.label!)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-destructive/10 text-destructive">
                    <Trash2 className="h-3.5 w-3.5" /> Remove label
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Inline rename */}
        {editId === node.label?.id && (
          <div className="py-1" style={{ paddingLeft: `${depth * 12 + 28}px` }}>
            <input
              autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveRename(node.label!); if (e.key === 'Escape') setEditId(null); }}
              onBlur={() => saveRename(node.label!)}
              className="w-full px-2 py-1 border border-border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        )}

        {hasChildren && isOpen && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className="mt-2">
      {confirmDialog}
      {createParent !== null && (
        <NewLabelDialog
          labels={labels}
          defaultParent={createParent}
          onClose={() => setCreateParent(null)}
          onCreated={() => { if (createParent) setOpenNodes((p) => new Set(p).add(createParent)); }}
        />
      )}
      <div className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-2 flex-1 hover:text-foreground">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Labels
        </button>
        <Tooltip content="Create label" delayMs={40}>
          <button onClick={() => { setCreateParent(''); setExpanded(true); }} className="hover:text-foreground" aria-label="Create label">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      {expanded && (
        <div className="mt-1 px-1">
          {tree.length === 0 && (
            <p className="px-3 py-1 text-xs text-muted-foreground normal-case font-normal tracking-normal">No labels yet — click + to add one.</p>
          )}
          {tree.map((node) => renderNode(node, 0))}
        </div>
      )}
    </div>
  );
}
