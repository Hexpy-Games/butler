import { $getNodeByKey, $getRoot, $isNodeSelection, $isRangeSelection, $setSelection,
  FOCUS_COMMAND, COMMAND_PRIORITY_HIGH, type BaseSelection, type LexicalEditor } from "lexical";

import { COMPOSER_FOCUS_EVENT, type ComposerFocusPlacement } from "./focusComposer";

export function registerComposerFocus(editor: LexicalEditor, saved: { current: BaseSelection | null }) {
  let pointer = false;
  let requested: ComposerFocusPlacement | null = null;
  let root: HTMLElement | null = null;
  const select = (placement: ComposerFocusPlacement) => {
    const previous = saved.current;
    if (placement === "restore" && $isRangeSelection(previous) &&
      $getNodeByKey(previous.anchor.key) && $getNodeByKey(previous.focus.key)) $setSelection(previous.clone());
    else if (placement === "restore" && $isNodeSelection(previous) &&
      previous.getNodes().every(node => $getNodeByKey(node.getKey()))) $setSelection(previous.clone());
    else $getRoot().selectEnd();
  };
  const focus = (event: Event) => {
    if (editor.isComposing()) return;
    const placement = (event as CustomEvent<ComposerFocusPlacement>).detail;
    requested = placement;
    editor.update(() => select(placement), { discrete: true });
    editor.focus(() => { requested = null; }, { defaultSelection: "rootEnd" });
  };
  const pointerDown = () => { pointer = true; };
  const pointerUp = () => { pointer = false; };
  const activate = () => {
    if (root === document.activeElement && !editor.isComposing()) {
      editor.update(() => select("end"));
    }
  };
  const removeRoot = editor.registerRootListener((next, previous) => {
    previous?.removeEventListener(COMPOSER_FOCUS_EVENT, focus);
    previous?.removeEventListener("pointerdown", pointerDown);
    next?.addEventListener(COMPOSER_FOCUS_EVENT, focus);
    next?.addEventListener("pointerdown", pointerDown);
    root = next;
  });
  const removeFocus = editor.registerCommand(FOCUS_COMMAND, () => {
    // Native text clicks own their hit-tested caret. Tab/DOM re-focus restores the draft selection.
    if (!pointer && !editor.isComposing()) select(requested ?? "restore");
    return false;
  }, COMMAND_PRIORITY_HIGH);
  document.addEventListener("pointerup", pointerUp);
  document.addEventListener("pointercancel", pointerUp);
  window.addEventListener("focus", activate);
  return () => {
    root?.removeEventListener(COMPOSER_FOCUS_EVENT, focus);
    root?.removeEventListener("pointerdown", pointerDown);
    removeRoot();
    removeFocus();
    document.removeEventListener("pointerup", pointerUp);
    document.removeEventListener("pointercancel", pointerUp);
    window.removeEventListener("focus", activate);
  };
}
