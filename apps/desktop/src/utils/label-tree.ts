import type { Label } from '@sarvinbox/core';

/** A node in the label hierarchy derived from slash-delimited label names. */
export interface LabelNode {
  name: string; // leaf segment (e.g. "test 2" for "test/test 2")
  path: string; // full slash-path (e.g. "test/test 2")
  label?: Label; // set when a real label exists at this exact path
  children: LabelNode[];
}

/**
 * Build a tree from slash-delimited label names ("Parent/Child" nests under
 * "Parent"). Intermediate segments with no matching label become containers
 * (node.label undefined). Shared single source used by the sidebar tree, the
 * apply-label menu, and the Labels settings list so they can never disagree
 * about how nesting is derived.
 */
export function buildLabelTree(labels: Label[]): LabelNode[] {
  const root: LabelNode[] = [];
  const byPath = new Map<string, LabelNode>();
  for (const label of labels) {
    const parts = label.name.split('/').map((p) => p.trim()).filter(Boolean);
    let acc = '';
    let siblings = root;
    parts.forEach((part, i) => {
      acc = i === 0 ? part : `${acc}/${part}`;
      let node = byPath.get(acc);
      if (!node) {
        node = { name: part, path: acc, children: [] };
        byPath.set(acc, node);
        siblings.push(node);
      }
      if (i === parts.length - 1) node.label = label;
      siblings = node.children;
    });
  }
  const sort = (nodes: LabelNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sort(n.children));
  };
  sort(root);
  return root;
}

/**
 * Flatten a label tree into depth-annotated rows (parents before their
 * children), for indented lists that show hierarchy without collapse/expand —
 * the apply-label menu and the Labels settings list.
 */
export function flattenLabelTree(
  nodes: LabelNode[],
  depth = 0,
): Array<{ node: LabelNode; depth: number }> {
  return nodes.flatMap((node) => [
    { node, depth },
    ...flattenLabelTree(node.children, depth + 1),
  ]);
}
