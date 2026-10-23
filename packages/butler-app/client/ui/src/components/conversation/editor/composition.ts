import { $addUpdateTag, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, $isTokenOrSegmented, $setCompositionKey,
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
const COMPOSITION_INPUT = new Set(["insertCompositionText", "deleteCompositionText", "insertFromComposition"]);

type CompositionState = { active: boolean; owned: BrowserOwnedElement | null; idle: number | null; waiting: Array<() => void> };
const states = new WeakMap<LexicalEditor, CompositionState>();
const listeners = new WeakMap<LexicalEditor, Set<() => void>>();

export function isComposerComposing(editor: LexicalEditor): boolean {
  const state = states.get(editor);
  return editor.isComposing() || state?.active === true || state?.owned != null;
}

/** Calls `listener` when the IME starts composing or goes idle. A composition in an owned
 * element changes no editor state, so editor update listeners miss both. */
export function subscribeComposing(editor: LexicalEditor, listener: () => void): () => void {
  const set = listeners.get(editor) ?? new Set();
  listeners.set(editor, set.add(listener));
  return () => { set.delete(listener); };
}

function notify(editor: LexicalEditor): void {
  listeners.get(editor)?.forEach(listener => listener());
}

/** Runs `write` now, or once the IME is idle. */
export function afterComposition(editor: LexicalEditor, write: () => void): void {
  const state = states.get(editor);
  if (state && isComposerComposing(editor)) state.waiting.push(write); else write();
}

/** A write from outside the editor waits for the IME; until it runs, it is the newer content. */
export function hasHeldWrites(editor: LexicalEditor): boolean {
  return (states.get(editor)?.waiting.length ?? 0) > 0;
}

function settle(editor: LexicalEditor, state: CompositionState): void {
  if (state.active) return;
  if (state.idle !== null) window.clearTimeout(state.idle);
  state.idle = null;
  const owned = state.owned;
  state.owned = null;
  if (owned) releaseElement(editor, owned);
  state.waiting.splice(0).forEach(write => write());
  notify(editor);
}

/** The editor is going away: keep committed text, unless a held write replaces it anyway. */
function settleOnUnmount(editor: LexicalEditor, state: CompositionState): void {
  if (state.idle !== null) window.clearTimeout(state.idle);
  const owned = state.owned;
  const replaced = state.waiting.length > 0;
  Object.assign(state, { active: false, owned: null, idle: null, waiting: [] });
  if (owned && !replaced) releaseElement(editor, owned);
}

function trackComposition(editor: LexicalEditor, state: CompositionState): () => void {
  let root: HTMLElement | null = null;
  const inEditor = (event: Event) => event.target instanceof Node && root?.contains(event.target) === true;
  const handlers: Record<string, (event: Event) => void> = {
    compositionstart: event => { if (inEditor(event)) { state.active = true; notify(editor); } },
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
      if (inEditor(event) && !input.isComposing && !COMPOSITION_INPUT.has(input.inputType)) settle(editor, state);
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
  };
}

function $startComposition(editor: LexicalEditor, state: CompositionState): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  // Lexical's own handler commits in a separate update that writes the selection.
  $addUpdateTag(SKIP_DOM_SELECTION_TAG);
  $addUpdateTag(COMPOSITION_START_TAG);
  if (state.owned) { $setCompositionKey(state.owned.key); return true; }
  const anchor = selection.anchor.getNode();
  const oneText = selection.isCollapsed() || (selection.anchor.key === selection.focus.key && selection.anchor.type === "text");
  if ($isTextNode(anchor) && $isTokenOrSegmented(anchor)) return false;
  // In text the browser composes in place, replacing a selection inside the node,
  // and Lexical reads it back from the DOM. The composition key goes on the text's
  // parent: on the text node itself Lexical would add its placeholder and suffix
  // characters. Keyed, Lexical treats the updates as one composition (history,
  // shortcuts, placeholder).
  if (oneText && $isTextNode(anchor)) { $setCompositionKey(anchor.getParentOrThrow().getKey()); return true; }
  // On an element, or over a selection across nodes, the browser owns their block.
  const block = oneText ? (selection.anchor.type === "element" ? anchor : null) : anchor.getTopLevelElement();
  if (!block || (!oneText && !block.is(selection.focus.getNode().getTopLevelElement()))) return false;
  state.owned = $isElementNode(block) ? $ownElement(editor, block, selection as RangeSelection) : null;
  if (!state.owned) return false;
  $setCompositionKey(state.owned.key);
  return true;
}

export function registerComposerComposition(editor: LexicalEditor): () => void {
  const state: CompositionState = { active: false, owned: null, idle: null, waiting: [] };
  states.set(editor, state);
  const keepDOMSelection = () => { if (isComposerComposing(editor)) $addUpdateTag(SKIP_DOM_SELECTION_TAG); return false; };
  const cleanup = mergeRegister(
    trackComposition(editor, state),
    editor.registerCommand(COMPOSITION_START_COMMAND, () => $startComposition(editor, state), COMMAND_PRIORITY_CRITICAL),
    // Lexical's copies of browser-composed text in an owned element; a commit the
    // browser was told not to insert is kept for the release.
    editor.registerCommand(CONTROLLED_TEXT_INSERTION_COMMAND, payload => {
      if (!state.owned) return false;
      if (payload instanceof InputEvent && payload.inputType === "insertFromComposition" && payload.defaultPrevented) {
        state.owned.committed += payload.data ?? "";
      }
      return true;
    }, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(COMPOSITION_END_COMMAND, keepDOMSelection, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(INPUT_COMMAND, keepDOMSelection, COMMAND_PRIORITY_CRITICAL),
    editor.registerCommand(SELECTION_CHANGE_COMMAND, keepDOMSelection, COMMAND_PRIORITY_CRITICAL),
    // Keys the IME consumes are not editor shortcuts.
    editor.registerCommand(KEY_DOWN_COMMAND, event => event.isComposing, COMMAND_PRIORITY_CRITICAL),
  );
  return () => {
    settleOnUnmount(editor, state);
    cleanup();
    states.delete(editor);
  };
}
