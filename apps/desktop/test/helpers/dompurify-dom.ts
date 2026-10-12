/**
 * Make happy-dom faithful enough for the REAL DOMPurify to sanitise under test
 * the way it does in Chromium.
 *
 * Out of the box, DOMPurify under happy-dom 20 leaves `onerror` handlers and
 * `javascript:` links in place while appearing to work — a sanitiser test would
 * pass or fail for happy-dom's reasons, not the app's. Two gaps cause it, and
 * both are closed here:
 *
 *  1. `Node.prototype.nodeName` returns '' in happy-dom (each subclass overrides
 *     it). DOMPurify reads names through that base getter, captured at import
 *     so markup cannot clobber `nodeName`, so every element looked nameless:
 *     `<p>` and `<table>` were unwrapped as unknown tags.
 *  2. happy-dom's NodeIterator is a TreeWalker, so when the node it is on is
 *     removed (exactly what DOMPurify does to a `<script>`), the walk ENDS and
 *     nothing after it is sanitised. A browser's NodeIterator survives the
 *     removal and carries on from where the node was.
 *
 * Import it FIRST in the test file (`import '../helpers/dompurify-dom';`),
 * before anything that imports dompurify — DOMPurify captures both at import.
 * Every test file using it must run in happy-dom.
 */

const nodePrototype = window.Node.prototype;
const baseNodeName = Object.getOwnPropertyDescriptor(nodePrototype, 'nodeName')?.get;

if (baseNodeName) {
  Object.defineProperty(nodePrototype, 'nodeName', {
    configurable: true,
    get(this: Node): string {
      // The most-derived class's own getter (Element, Text, Comment, …) — what
      // the browser's native getter answers for this node.
      for (
        let proto = Object.getPrototypeOf(this) as object | null;
        proto && proto !== nodePrototype;
        proto = Object.getPrototypeOf(proto) as object | null
      ) {
        const getter = Object.getOwnPropertyDescriptor(proto, 'nodeName')?.get;
        if (getter) return getter.call(this) as string;
      }
      return baseNodeName.call(this) as string;
    },
  });
}

/** The next node after `node` in document order, staying inside `root`. */
const following = (node: Node, root: Node): Node | null => {
  if (node.firstChild) return node.firstChild;
  for (let current: Node | null = node; current && current !== root; current = current.parentNode) {
    if (current.nextSibling) return current.nextSibling;
  }
  return null;
};

/** The node before `node` in document order (its previous sibling's last descendant, else its parent). */
const preceding = (node: Node, root: Node): Node => {
  if (node === root) return root;
  let previous = node.previousSibling;
  if (!previous) return node.parentNode ?? root;
  while (previous.lastChild) previous = previous.lastChild;
  return previous;
};

/** `whatToShow` bit for a node type, as NodeFilter defines it (SHOW_ELEMENT = 1 << 0, …). */
const shown = (whatToShow: number, node: Node): boolean =>
  ((whatToShow >>> 0) & (1 << (node.nodeType - 1))) !== 0;

// The prototype that actually defines it. `window.Document` is NOT in a
// happy-dom document's chain (it is a per-window subclass), so it is found by
// walking up from the live document instead.
let documentPrototype = Object.getPrototypeOf(document) as Document | null;
while (documentPrototype && !Object.prototype.hasOwnProperty.call(documentPrototype, 'createNodeIterator')) {
  documentPrototype = Object.getPrototypeOf(documentPrototype) as Document | null;
}
if (!documentPrototype) throw new Error('dompurify-dom: no createNodeIterator on this document');

documentPrototype.createNodeIterator = function createNodeIterator(
  root: Node,
  whatToShow = 0xffffffff,
  filter: NodeFilter | null = null
): NodeIterator {
  // Where the walk is. `before` is the node preceding it, recorded when it was
  // returned: if the reference is removed, the walk resumes from there — which
  // is where the browser's pre-removing steps move a NodeIterator's reference.
  let reference: Node | null = null;
  let before: Node = root;
  const accepts = (node: Node) => {
    if (!shown(whatToShow, node)) return false;
    if (!filter) return true;
    const verdict = typeof filter === 'function' ? filter(node) : filter.acceptNode(node);
    return verdict === NodeFilter.FILTER_ACCEPT;
  };
  return {
    root,
    whatToShow,
    filter,
    referenceNode: root,
    pointerBeforeReferenceNode: true,
    detach() {},
    previousNode: () => {
      throw new Error('dompurify-dom: previousNode is not implemented');
    },
    nextNode(): Node | null {
      let candidate: Node | null;
      if (reference === null) candidate = root;
      else if (reference === root || root.contains(reference)) candidate = following(reference, root);
      else candidate = following(before, root);
      for (; candidate; candidate = following(candidate, root)) {
        if (accepts(candidate)) {
          before = preceding(candidate, root);
          reference = candidate;
          return candidate;
        }
      }
      return null;
    },
  } as unknown as NodeIterator;
};

export {};
