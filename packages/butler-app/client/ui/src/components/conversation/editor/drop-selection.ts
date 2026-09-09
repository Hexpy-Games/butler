import { $createRangeSelection, $setSelection, type LexicalEditor } from "lexical";

/** Resolve the browser's caret at the drop point, never at the end of the draft. */
export function $selectDropPoint(editor: LexicalEditor, event: DragEvent): boolean {
  const root = editor.getRootElement();
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (!root || !range || !root.contains(range.startContainer)) return false;
  const selection = $createRangeSelection();
  selection.applyDOMRange(range);
  $setSelection(selection);
  return true;
}
