import { $getSelection, $isRangeSelection, $isNodeSelection, $insertNodes, COPY_COMMAND, CUT_COMMAND, PASTE_COMMAND, COMMAND_PRIORITY_HIGH, type LexicalEditor } from "lexical";
import { $generateJSONFromSelectedNodes } from "@lexical/clipboard";
import { isMessageContent, messageContentText } from "@/app/messageContent";
import { $nodesForContent, contentFromSerializedNodes } from "./serialization";

export const BUTLER_CONTENT_MIME = "application/x-butler-message-content";
export function registerComposerClipboard(editor: LexicalEditor, knownSession: (id: string) => boolean): () => void {
  function copy(event: ClipboardEvent | KeyboardEvent | null, cut: boolean): boolean {
    const selection = $getSelection();
    if (!event || !("clipboardData" in event) || !event.clipboardData || !selection) return false;
    const content = contentFromSerializedNodes($generateJSONFromSelectedNodes(editor, selection).nodes);
    event.preventDefault();
    event.clipboardData.setData("text/plain", messageContentText(content));
    event.clipboardData.setData(BUTLER_CONTENT_MIME, JSON.stringify(content));
    if (cut && $isRangeSelection(selection)) selection.removeText();
    if (cut && $isNodeSelection(selection)) selection.getNodes().forEach(node => node.remove());
    return true;
  }
  const cleanups = [
    editor.registerCommand(COPY_COMMAND, event => copy(event, false), COMMAND_PRIORITY_HIGH),
    editor.registerCommand(CUT_COMMAND, event => copy(event, true), COMMAND_PRIORITY_HIGH),
    editor.registerCommand(PASTE_COMMAND, event => {
      if (!(event instanceof ClipboardEvent) || !event.clipboardData || event.clipboardData.files.length) return false;
      const raw = event.clipboardData.getData(BUTLER_CONTENT_MIME);
      if (raw) {
        try {
          const content: unknown = JSON.parse(raw);
          if (isMessageContent(content) && content.parts.every(part => part.type !== "session_ref" || knownSession(part.sessionId))) {
            event.preventDefault(); $insertNodes($nodesForContent(content)); return true;
          }
        } catch { /* Foreign clipboard falls through to plain text. */ }
      }
      event.preventDefault();
      $insertNodes($nodesForContent({ version: 1, parts: [{ type: "text", text: event.clipboardData.getData("text/plain") }] }));
      return true;
    }, COMMAND_PRIORITY_HIGH),
  ];
  return () => cleanups.forEach(cleanup => cleanup());
}
