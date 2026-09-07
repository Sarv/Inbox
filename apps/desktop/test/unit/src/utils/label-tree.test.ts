import type { Label } from '@sarvinbox/core';
import { describe, it, expect } from 'vitest';

import { buildLabelTree, flattenLabelTree } from '../../../../src/utils/label-tree';

const label = (name: string, over: Partial<Label> = {}): Label => ({
  id: `id-${name}`,
  name,
  color: '#2563eb',
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('buildLabelTree', () => {
  // The sidebar, the apply-label menu and the Labels settings list all render
  // from this one tree — a disagreement here shows up as a label appearing at
  // the wrong nesting level in one surface but not the others.
  it('returns an empty tree for no labels', () => {
    expect(buildLabelTree([])).toEqual([]);
  });

  it('keeps a flat label at the root with its own label attached', () => {
    const tree = buildLabelTree([label('Work')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('Work');
    expect(tree[0].path).toBe('Work');
    expect(tree[0].label?.id).toBe('id-Work');
    expect(tree[0].children).toEqual([]);
  });

  it('nests "Parent/Child" under its parent and uses the leaf segment as the name', () => {
    const tree = buildLabelTree([label('Work'), label('Work/Clients')]);
    expect(tree).toHaveLength(1);
    const child = tree[0].children[0];
    expect(child.name).toBe('Clients'); // leaf segment, not the full path
    expect(child.path).toBe('Work/Clients'); // full path for lookups
    expect(child.label?.id).toBe('id-Work/Clients');
  });

  it('synthesises ORPHAN parents as label-less containers', () => {
    // Only the deep label exists. The intermediate rows must still render (so
    // the child is reachable) but must NOT be clickable/editable as labels.
    const tree = buildLabelTree([label('a/b/c')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBeUndefined();
    expect(tree[0].children[0].label).toBeUndefined();
    expect(tree[0].children[0].children[0].label?.id).toBe('id-a/b/c');
    expect(tree[0].children[0].children[0].path).toBe('a/b/c');
  });

  it('back-fills a container node when the real parent label arrives LATER', () => {
    // Registration order must not matter: "a/b" created the container "a", and
    // the later "a" label has to attach to that same node, not create a sibling.
    const tree = buildLabelTree([label('a/b'), label('a')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].label?.id).toBe('id-a');
    expect(tree[0].children).toHaveLength(1);
  });

  it('trims whitespace around segments and drops empty ones', () => {
    // "Work / Clients" and "Work//Clients" are the same path as "Work/Clients";
    // without normalisation each variant would mint a duplicate tree branch.
    const tree = buildLabelTree([label(' Work / Clients ')]);
    expect(tree[0].path).toBe('Work');
    expect(tree[0].children[0].path).toBe('Work/Clients');

    const collapsed = buildLabelTree([label('Work//Clients')]);
    expect(collapsed[0].children[0].path).toBe('Work/Clients');
  });

  it('ignores a label whose name is only delimiters (no segments)', () => {
    expect(buildLabelTree([label('///')])).toEqual([]);
  });

  it('sorts siblings alphabetically at every depth', () => {
    const tree = buildLabelTree([
      label('Zebra'),
      label('Apple'),
      label('Apple/zulu'),
      label('Apple/alpha'),
    ]);
    expect(tree.map((n) => n.name)).toEqual(['Apple', 'Zebra']);
    expect(tree[0].children.map((n) => n.name)).toEqual(['alpha', 'zulu']);
  });

  it('does not duplicate a shared parent across two children', () => {
    const tree = buildLabelTree([label('p/one'), label('p/two')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].children.map((n) => n.path)).toEqual(['p/one', 'p/two']);
  });
});

describe('flattenLabelTree', () => {
  // Drives the indented (non-collapsible) lists. Parents must precede their
  // children or the indentation reads as a broken hierarchy.
  it('emits parents before children with increasing depth', () => {
    const tree = buildLabelTree([label('a'), label('a/b'), label('a/b/c'), label('z')]);
    expect(flattenLabelTree(tree).map(({ node, depth }) => [node.path, depth])).toEqual([
      ['a', 0],
      ['a/b', 1],
      ['a/b/c', 2],
      ['z', 0],
    ]);
  });

  it('accepts a starting depth offset (for rendering a subtree)', () => {
    const tree = buildLabelTree([label('a/b')]);
    expect(flattenLabelTree(tree, 3).map(({ depth }) => depth)).toEqual([3, 4]);
  });

  it('returns an empty list for an empty tree', () => {
    expect(flattenLabelTree([])).toEqual([]);
  });
});
