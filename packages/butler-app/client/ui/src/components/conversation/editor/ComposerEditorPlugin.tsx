import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, $isNodeSelection, $setSelection, $getRoot, $getNodeByKey, $insertNodes, $addUpdateTag, HISTORY_PUSH_TAG, SKIP_DOM_SELECTION_TAG, DROP_COMMAND, DRAGOVER_COMMAND, COMMAND_PRIORITY_HIGH, type BaseSelection } from "lexical";
import { useComposerStore } from "../composerStore";
import { useButlerStore } from "@/app/store";
import { SESSION_REFERENCE_MIME } from "@/app/space/drag";
import { $createSessionReferenceNode } from "./SessionReferenceNode";
import { $readComposerContent, $replaceComposerContent } from "./serialization";
import { registerComposerClipboard } from "./clipboard";
import { $selectDropPoint } from "./drop-selection";

export function ComposerEditorPlugin() {
  const [editor] = useLexicalComposerContext();
  const text = useComposerStore(state => state.text);
  const parts = useComposerStore(state => state.contentParts);
  const savedSelection = useRef<BaseSelection | null>(null);
  useEffect(() => {
    const desired = parts ?? { version: 1 as const, parts: text ? [{ type: "text" as const, text }] : [] };
    const current = editor.getEditorState().read($readComposerContent);
    if (JSON.stringify(current) !== JSON.stringify(desired)) editor.update(() => $replaceComposerContent(desired), { tag: SKIP_DOM_SELECTION_TAG });
  }, [editor, parts, text]);
  useEffect(() => {
    const knownSession = (id: string) => id === "general" || useButlerStore.getState().navigation.space.nodes.some(node => node.kind === "session" && node.entityId === id);
    function insert(reference: { sessionId: string; titleSnapshot: string }, drop?: DragEvent) {
      if (!knownSession(reference.sessionId)) return;
      editor.update(() => {
        const previous = savedSelection.current;
        if (drop && $selectDropPoint(editor, drop)) { /* The drop owns the insertion point. */ }
        else if ($isNodeSelection(previous) && previous.getNodes().every(node => $getNodeByKey(node.getKey()))) $setSelection(previous.clone());
        else if ($isRangeSelection(previous) && $getNodeByKey(previous.anchor.key) && $getNodeByKey(previous.focus.key)) $setSelection(previous.clone());
        else $getRoot().selectEnd();
        $insertNodes([$createSessionReferenceNode(reference.sessionId, reference.titleSnapshot)]);
        $addUpdateTag(HISTORY_PUSH_TAG);
      });
      editor.focus();
    }
    useComposerStore.setState({ insertSessionReference: insert });
    const cleanups = [
      editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
        editorState.read(() => {
          const selection = $getSelection();
          if (selection) savedSelection.current = selection.clone();
          if (!dirtyElements.size && !dirtyLeaves.size) return;
          const content = $readComposerContent();
          const state = useComposerStore.getState();
          const existing = state.contentParts ?? { version: 1, parts: state.text ? [{ type: "text", text: state.text }] : [] };
          if (JSON.stringify(content) !== JSON.stringify(existing)) state.setContentParts(content);
        });
      }),
      registerComposerClipboard(editor, knownSession),
      editor.registerCommand(DRAGOVER_COMMAND, event => {
        if (!event.dataTransfer?.types.includes(SESSION_REFERENCE_MIME)) return false;
        event.preventDefault(); event.dataTransfer.dropEffect = "copy"; return true;
      }, COMMAND_PRIORITY_HIGH),
      editor.registerCommand(DROP_COMMAND, event => {
        const raw = event.dataTransfer?.getData(SESSION_REFERENCE_MIME);
        if (!raw) return false;
        event.preventDefault(); event.stopPropagation();
        try { const ref = JSON.parse(raw); if (typeof ref.sessionId === "string" && typeof ref.titleSnapshot === "string") insert(ref, event); } catch { /* Invalid drag carries no reference. */ }
        return true;
      }, COMMAND_PRIORITY_HIGH),
    ];
    return () => {
      cleanups.forEach(cleanup => cleanup());
      if (useComposerStore.getState().insertSessionReference === insert) useComposerStore.setState({ insertSessionReference: null });
    };
  }, [editor]);
  return null;
}
