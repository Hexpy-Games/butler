import { $addUpdateTag, $getNodeByKey, $setCompositionKey, $setSelection, SKIP_DOM_SELECTION_TAG, setDOMUnmanaged,
  type LexicalEditor, type NodeKey, type RangeSelection } from "lexical";

/**
 * An element the browser composes in on its own. With the caret on an element (an
 * empty line, beside a reference) there is no text node to compose in, and Lexical
 * would create one after composition has started. Instead Lexical leaves the
 * element alone, the browser inserts its own text, and once the IME is idle the
 * element's DOM is put back and that text is inserted through Lexical.
 */
export type BrowserOwnedElement = {
  key: NodeKey;
  element: HTMLElement;
  selection: RangeSelection;
  /** Text length before the caret, and the element's text, when composition started. */
  offset: number;
  text: string;
  records: MutationRecord[];
  observer: MutationObserver;
};

function textBefore(element: HTMLElement): number | null {
  const selection = element.ownerDocument.getSelection();
  if (!selection?.rangeCount || !element.contains(selection.anchorNode)) return null;
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  range.setEnd(selection.anchorNode!, selection.anchorOffset);
  return range.toString().length;
}

/** Inside the compositionstart update. */
export function $ownElement(editor: LexicalEditor, selection: RangeSelection): BrowserOwnedElement | null {
  const key = selection.anchor.key;
  const element = editor.getElementByKey(key);
  const offset = element && element !== editor.getRootElement() ? textBefore(element) : null;
  if (!element || offset === null) return null;
  const owned: BrowserOwnedElement = { key, element, selection: selection.clone(), offset, text: element.textContent ?? "",
    records: [], observer: new MutationObserver(records => owned.records.push(...records)) };
  owned.observer.observe(element, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  setDOMUnmanaged(element, { captureSelection: true });
  return owned;
}

/** Puts the element's DOM back to what Lexical last rendered. */
function revert(records: MutationRecord[]): void {
  for (const record of [...records].reverse()) {
    if (record.type === "characterData") { record.target.nodeValue = record.oldValue; continue; }
    record.addedNodes.forEach(node => node.parentNode?.removeChild(node));
    record.removedNodes.forEach(node => record.target.insertBefore(node, record.nextSibling));
  }
}

/** Outside any update, while no composition is active. */
export function releaseElement(editor: LexicalEditor, owned: BrowserOwnedElement): void {
  const now = owned.element.textContent ?? "";
  const inserted = now.slice(owned.offset, owned.offset + Math.max(0, now.length - owned.text.length));
  owned.observer.disconnect();
  revert([...owned.records, ...owned.observer.takeRecords()]);
  // setDOMUnmanaged has no inverse; drop its marks so Lexical manages the element again.
  const marks = owned.element as unknown as Record<string, unknown>;
  delete marks.__lexicalUnmanaged;
  delete marks.__lexicalCapturedSelection;
  // A commit caused by leaving the editor must not pull focus back to it.
  const focused = owned.element.ownerDocument.activeElement === editor.getRootElement();
  editor.update(() => {
    if (!focused) $addUpdateTag(SKIP_DOM_SELECTION_TAG);
    $setCompositionKey(null);
    $getNodeByKey(owned.key)?.markDirty();
    const selection = owned.selection.clone();
    $setSelection(selection);
    if (inserted) selection.insertText(inserted);
  }, { discrete: true });
}
