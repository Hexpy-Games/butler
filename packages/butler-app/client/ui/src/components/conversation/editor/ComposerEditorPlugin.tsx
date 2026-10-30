import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection, $isNodeSelection, $setSelection, $getRoot, $getNodeByKey, $insertNodes, $addUpdateTag, HISTORY_PUSH_TAG, DROP_COMMAND, DRAGOVER_COMMAND, COMMAND_PRIORITY_HIGH, type BaseSelection } from "lexical";
import { useComposerStore } from "../composerStore";
import { useButlerStore } from "@/app/store";
import { SESSION_REFERENCE_MIME } from "@/app/space/drag";
import { $createSessionReferenceNode } from "./SessionReferenceNode";
import { $readComposerContent } from "./serialization";
import type { MessageContentPart } from "@/app/messageContent";
import { registerComposerClipboard } from "./clipboard";
import { $selectDropPoint } from "./drop-selection";
import { registerComposerFocus } from "./composerFocus";
import { registerComposerComposition } from "./composition";
import { saveDraftFromEditor, syncEditorFromStore } from "./draftSync";
import { focusComposer } from "./focusComposer";
import { useHotkey } from "@/butler-ds";
import { KEY_ENTER_COMMAND } from "lexical";

export function ComposerEditorPlugin() {
  const [editor] = useLexicalComposerContext();
  const text = useComposerStore(state => state.text);
  const parts = useComposerStore(state => state.contentParts);
  const savedSelection = useRef<BaseSelection | null>(null);
  useHotkey("mod+shift+e", () => focusComposer(editor.getRootElement()), { enabled: true });
  useEffect(() => registerComposerFocus(editor, savedSelection), [editor]);
  // Declared before the update listener below: its unmount flush saves committed text through that listener.
  useEffect(() => registerComposerComposition(editor), [editor]);
  // Handle send before PlainTextPlugin inserts a line break. React's bubble
  // handler sees defaultPrevented and cannot submit the same key twice.
  useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, event => {
    if (!event) return false;
    if (event.isComposing || event.keyCode === 229) return true;
    useComposerStore.getState().handleKeyDown(event);
    return event.defaultPrevented;
  }, COMMAND_PRIORITY_HIGH), [editor]);
  useEffect(() => syncEditorFromStore(editor), [editor, parts, text]);
  useEffect(() => {
    const sessionId = useComposerStore.getState().draftSessionId;
    const knownSession = (id: string) => id === "general" || useButlerStore.getState().navigation.space.nodes.some(node => node.kind === "session" && node.entityId === id);
    const knownReference = (part: MessageContentPart) => part.type === "session_ref" ? knownSession(part.sessionId)
      : part.type !== "project_ref" || useButlerStore.getState().navigation.projects.some(project => project.id === part.projectId && !project.archived);
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
    function appendText(text: string) {
      editor.update(() => {
        $getRoot().selectEnd().insertText(text);
        $addUpdateTag(HISTORY_PUSH_TAG);
      });
      editor.focus();
    }
    useComposerStore.setState({ insertSessionReference: insert, appendDraftText: appendText });
    const cleanups = [
      editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
        editorState.read(() => {
          const selection = $getSelection();
          if (selection) savedSelection.current = selection.clone();
          if (dirtyElements.size || dirtyLeaves.size) saveDraftFromEditor(editor, sessionId, $readComposerContent());
        });
      }),
      registerComposerClipboard(editor, knownReference, (files) => useComposerStore.getState().addFiles(files)),
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
      if (useComposerStore.getState().appendDraftText === appendText) useComposerStore.setState({ appendDraftText: null });
    };
  }, [editor]);
  return null;
}
