import { $addUpdateTag, $getSelection, $isRangeSelection, $isTextNode, $isTokenOrSegmented, $setCompositionKey,
  COMMAND_PRIORITY_CRITICAL, COMPOSITION_END_COMMAND, COMPOSITION_START_COMMAND, COMPOSITION_START_TAG,
  CONTROLLED_TEXT_INSERTION_COMMAND, INPUT_COMMAND, KEY_DOWN_COMMAND, SELECTION_CHANGE_COMMAND, SKIP_DOM_SELECTION_TAG,
  mergeRegister, type LexicalEditor, type RangeSelection } from "lexical";
import { $ownElement, releaseElement, type BrowserOwnedElement } from "./browserComposition";

// The IME owns the document while it composes. IMEs that track the text (Android,
// Windows TSF) commit as soon as anything else edits it or moves the selection,
// which splits Hangul into jamo. An IME also starts its next syllable in the same
// step that commits the last one. So the composer writes neither text nor selection
// from compositionstart until the IME is idle; Lexical reads the result from the DOM.

const IME_IDLE_MS = 100;

type CompositionState = { active: boolean; owned: BrowserOwnedElement | null; idle: number | null; waiting: Array<() => void> };
const states = new WeakMap<LexicalEditor, CompositionState>();

export function isComposerComposing(editor: LexicalEditor): boolean {
  const state = states.get(editor);
  return editor.isComposing() || state?.active === true || state?.owned != null;
}

/** Runs `write` now, or once the IME is idle. */
export function afterComposition(editor: LexicalEditor, write: () => void): void {
  const state = states.get(editor);
  if (state && isComposerComposing(editor)) state.waiting.push(write); else write();
}

function settle(editor: LexicalEditor, state: CompositionState): void {
  if (state.active) return;
  if (state.idle !== null) window.clearTimeout(state.idle);
  state.idle = null;
  const owned = state.owned;
  state.owned = null;
  if (owned) releaseElement(editor, owned);
  state.waiting.splice(0).forEach(write => write());
}

function trackComposition(editor: LexicalEditor, state: CompositionState): () => void {
  let root: HTMLElement | null = null;
  const inEditor = (event: Event) => event.target instanceof Node && root?.contains(event.target) === true;
  const handlers: Record<string, (event: Event) => void> = {
    compositionstart: event => { if (inEditor(event)) state.active = true; },
    // A commit is usually followed by the IME's next syllable, which can arrive as a
    // separate task; settle only once the IME has stayed idle.
    compositionend: event => {
      if (!inEditor(event)) return;
      state.active = false;
      if (state.idle !== null) window.clearTimeout(state.idle);
      state.idle = window.setTimeout(() => { state.idle = null; settle(editor, state); }, IME_IDLE_MS);
    },
    // Input that is not the IME's own finds the document settled first.
    keydown: event => {
      const key = event as KeyboardEvent;
      if (inEditor(event) && !key.isComposing && key.keyCode !== 229) settle(editor, state);
    },
    beforeinput: event => {
      const input = event as InputEvent;
      if (inEditor(event) && !input.isComposing && input.inputType !== "insertCompositionText") settle(editor, state);
    },
    pointerdown: () => settle(editor, state),
    focusout: event => { if (inEditor(event)) settle(editor, state); },
  };
  const removeRoot = editor.registerRootListener(next => { root = next; });
  // Capture on the window runs before Lexical's own listeners on the editor root.
  for (const [type, handler] of Object.entries(handlers)) window.addEventListener(type, handler, true);
  return () => {
    removeRoot();
    for (const [type, handler] of Object.entries(handlers)) window.removeEventListener(type, handler, true);
    if (state.idle !== null) window.clearTimeout(state.idle);
  };
}

function $startComposition(editor: LexicalEditor, state: CompositionState): boolean {
  const selection = $getSelection();
  const collapsed = $isRangeSelection(selection) && selection.isCollapsed() ? selection : null;
  const anchor = collapsed?.anchor.getNode();
  if (!state.owned && (!collapsed || ($isTextNode(anchor) && $isTokenOrSegmented(anchor)))) return false;
  // Lexical's own handler commits in a separate update that writes the selection.
  $addUpdateTag(SKIP_DOM_SELECTION_TAG);
  $addUpdateTag(COMPOSITION_START_TAG);
  // In text the browser composes in place and Lexical reads it back from the DOM;
  // marking that node as composing would add Lexical's placeholder and suffix.
  if (!state.owned && $isTextNode(anchor)) return true;
  state.owned ??= $ownElement(editor, collapsed as RangeSelection);
  if (!state.owned) return false;
  $setCompositionKey(state.owned.key);
  return true;
}

export function registerComposerComposition(editor: LexicalEditor): () => void {
  const state: CompositionState = { active: false, owned: null, idle: null, waiting: [] };
  states.set(editor, state);
  const keepDOMSelection = () => { if (isComposerComposing(editor)) $addUpdateTag(SKIP_DOM_SELECTION_TAG); return false; };
  return mergeRegister(
    trackComposition(editor, state),
    editor.registerCommand(COMPOSITION_START_COMMAND, () => $startComposition(editor, state), COMMAND_PRIORITY_CRITICAL),
    // Lexical's copies of browser-composed text in an owned element.
    editor.registerCommand(CONTROLLED_TEXT_INSERTION_COMMAND, () => state.owned !== null, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(COMPOSITION_END_COMMAND, keepDOMSelection, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(INPUT_COMMAND, keepDOMSelection, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(SELECTION_CHANGE_COMMAND, keepDOMSelection, COMMAND_PRIORITY_CRITICAL),
    // Keys the IME consumes are not editor shortcuts.
    editor.registerCommand(KEY_DOWN_COMMAND, event => event.isComposing, COMMAND_PRIORITY_CRITICAL),
    () => { states.delete(editor); },
  );
}
