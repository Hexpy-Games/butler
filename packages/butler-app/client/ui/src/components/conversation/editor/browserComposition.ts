import { $addUpdateTag, $createRangeSelection, $getNodeByKey, $isElementNode, $parseSerializedNode, $setCompositionKey,
  $setSelection, SKIP_DOM_SELECTION_TAG, setDOMUnmanaged, type ElementNode, type LexicalEditor, type LexicalNode,
  type NodeKey, type PointType, type RangeSelection, type SerializedLexicalNode } from "lexical";

/**
 * An element the browser composes in on its own. With the caret on an element (an
 * empty line, beside a reference) there is no text node to compose in, and over a
 * selection across nodes the browser removes nodes; Lexical would rebuild the DOM
 * after composition has started. Instead Lexical leaves the element alone, the
 * browser edits it, and once the IME is idle the element is rebuilt as it was and
 * the edit is replayed through Lexical.
 */
type SavedPoint = { path: number[]; offset: number; type: "text" | "element" };
export type BrowserOwnedElement = {
  key: NodeKey;
  element: HTMLElement;
  /** The element as it was, and the selection the browser composes over, by child path. */
  json: SerializedLexicalNode;
  anchor: SavedPoint;
  focus: SavedPoint;
  /** Text lengths before and after that selection when composition started. */
  before: number;
  after: number;
  /** Committed text the browser was told not to insert (WebKit's insertFromComposition). */
  committed: string;
};

/** Text lengths in `element` before and after the window selection, if it lies inside. */
function around(element: HTMLElement): { before: number; after: number } | null {
  const selection = element.ownerDocument.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
  const measure = element.ownerDocument.createRange();
  measure.selectNodeContents(element);
  measure.setEnd(range.startContainer, range.startOffset);
  const before = measure.toString().length;
  measure.selectNodeContents(element);
  measure.setStart(range.endContainer, range.endOffset);
  return { before, after: measure.toString().length };
}

function $serialize(node: LexicalNode): SerializedLexicalNode {
  const json = node.exportJSON() as SerializedLexicalNode & { children?: SerializedLexicalNode[] };
  if ($isElementNode(node)) json.children = node.getChildren().map($serialize);
  return json;
}

function savePoint(point: PointType, block: ElementNode): SavedPoint {
  const path: number[] = [];
  for (let node: LexicalNode = point.getNode(); !node.is(block); node = node.getParentOrThrow()) path.unshift(node.getIndexWithinParent());
  return { path, offset: point.offset, type: point.type };
}

function $restorePoint(point: PointType, saved: SavedPoint, block: ElementNode): void {
  let node: LexicalNode = block;
  for (const index of saved.path) node = ($isElementNode(node) ? node.getChildAtIndex(index) : null) ?? node;
  point.set(node.getKey(), saved.offset, saved.type);
}

/** Inside the compositionstart update, before anything changed the DOM. */
export function $ownElement(editor: LexicalEditor, block: ElementNode, selection: RangeSelection): BrowserOwnedElement | null {
  const element = editor.getElementByKey(block.getKey());
  const text = element && element !== editor.getRootElement() ? around(element) : null;
  if (!element || !text) return null;
  // Lexical ignores DOM changes under unmanaged elements, which keeps it from undoing the browser's edit.
  for (const dom of [element, ...element.querySelectorAll<HTMLElement>("*")]) setDOMUnmanaged(dom, { captureSelection: true });
  return { key: block.getKey(), element, json: $serialize(block), anchor: savePoint(selection.anchor, block),
    focus: savePoint(selection.focus, block), ...text, committed: "" };
}

/** Outside any update, while no composition is active. */
export function releaseElement(editor: LexicalEditor, owned: BrowserOwnedElement): void {
  // The browser replaced the selection with its text; everything around it is unchanged.
  const now = owned.element.textContent ?? "";
  const inserted = now.slice(owned.before, Math.max(owned.before, now.length - owned.after)) + owned.committed;
  // A commit caused by leaving the editor must not pull focus back to it.
  const focused = owned.element.ownerDocument.activeElement === editor.getRootElement();
  editor.update(() => {
    if (!focused) $addUpdateTag(SKIP_DOM_SELECTION_TAG);
    $setCompositionKey(null);
    const current = $getNodeByKey(owned.key);
    if (!current) return;
    // The element as it was gets a new DOM element, which drops the browser's DOM and
    // the unmanaged marks; Lexical may have read the browser's edit into its nodes meanwhile.
    const block = $parseSerializedNode(owned.json) as ElementNode;
    current.replace(block);
    const selection = $createRangeSelection();
    $restorePoint(selection.anchor, owned.anchor, block);
    $restorePoint(selection.focus, owned.focus, block);
    $setSelection(selection);
    if (inserted || !selection.isCollapsed()) selection.insertText(inserted);
  }, { discrete: true });
}
