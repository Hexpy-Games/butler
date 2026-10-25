import { ClickableLinkPlugin } from "@lexical/react/LexicalClickableLinkPlugin";
import { memo, useEffect, useRef } from "react";
import { $getRoot, $getSelection, $isNodeSelection, $getNodeByKey, COMMAND_PRIORITY_HIGH, KEY_BACKSPACE_COMMAND, KEY_DELETE_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ARROW_DOWN_COMMAND, type LexicalEditor } from "lexical";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { HeadingNode } from "@lexical/rich-text";
import { ListItemNode, ListNode } from "@lexical/list";
import { LinkNode } from "@lexical/link";
import { documentEditorClasses } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { BlocksNode, ImageNode, RawMarkdownNode, DocumentAssets, DocumentOperations } from "./DocumentNodes";
import { DOCUMENT_TRANSFORMERS, exportDocument, importDocument, markDocumentChanges, nodeMarkdown, type MarkdownSource } from "./documentMarkdown";
import { DocumentFormat } from "./DocumentFormat";
import type { EditableDocument } from "./documentApi";
import type { DocumentUpdate } from "@/app/documentEvents";
interface Props { doc: EditableDocument; body: string; loadId: number; changed: DocumentUpdate["changed"]; editing: boolean; onDirty: () => void; registerDraft: (read: () => string) => () => void; onBlur: () => void; flush: () => Promise<void> }
export const DocumentBody = memo(function DocumentBody(props: Props) {
  return <DocumentOperations.Provider value={{ id: props.doc.id, flush: props.flush }}><DocumentAssets.Provider value={props.doc.assets ?? []}><LexicalComposer initialConfig={{
    namespace: "Document", nodes: [HeadingNode, ListNode, ListItemNode, LinkNode, BlocksNode, ImageNode, RawMarkdownNode],
    theme: { text: { bold: documentEditorClasses.bold, italic: documentEditorClasses.italic } },
    onError: error => { throw error; },
  }}><RichTextPlugin contentEditable={<ContentEditable className={documentEditorClasses.root} aria-label={appCopy.documents.title} data-document-id={props.doc.id} onBlur={props.onBlur} />} ErrorBoundary={LexicalErrorBoundary} />
    <BodySync {...props} /><HistoryPlugin /><ListPlugin /><ClickableLinkPlugin newTab /><MarkdownShortcutPlugin transformers={DOCUMENT_TRANSFORMERS} /><DocumentFormat />
  </LexicalComposer></DocumentAssets.Provider></DocumentOperations.Provider>;
});
function BodySync({ body, loadId, changed, editing, onDirty, registerDraft }: Props) {
  const [editor] = useLexicalComposerContext();
  const source = useRef<MarkdownSource>({ nodes: new Map(), prefix: "" });
  const current = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (body === current.current) return;
    current.current = body;
    editor.update(() => { const selected = $getSelection() !== null; source.current = importDocument(body); if (selected) $getRoot().selectEnd(); }, { tag: "document-load", discrete: true });
  // Local keystrokes must never trigger a Markdown reload or move the caret.
  }, [loadId, editor]);
  useEffect(() => registerDraft(() => editor.getEditorState().read(() => {
    const body = exportDocument(source.current); current.current = body; return body;
  })), [editor, registerDraft]);
  useEffect(() => editor.registerUpdateListener(({ editorState, tags, dirtyElements, dirtyLeaves }) => {
    if (tags.has("document-load") || (!dirtyElements.size && !dirtyLeaves.size)) return;
    editorState.read(() => markDocumentChanges(source.current, [...dirtyLeaves, ...[...dirtyElements].filter(([, intentional]) => intentional).map(([key]) => key)]));
    onDirty();
  }), [editor, onDirty]);
  const highlighted = useRef<HTMLElement[]>([]);
  useEffect(() => {
    highlighted.current.forEach(element => element.setAttribute("data-butler-editing", "false"));
    highlighted.current = [];
    if (!editing) return;
    editor.getEditorState().read(() => {
      let line = source.current.prefix.split("\n").length;
      for (const node of $getRoot().getChildren()) {
        const original = source.current.nodes.get(node.getKey());
        const raw = original?.raw ?? nodeMarkdown(node), end = line + raw.split("\n").length - 1;
        const active = changed.some(range => range.start_line <= end && range.end_line >= line);
        const element = editor.getElementByKey(node.getKey());
        if (active && element) { element.setAttribute("data-butler-editing", "true"); highlighted.current.push(element); }
        line += (raw + (original?.gap ?? "\n\n")).split("\n").length - 1;
      }
    });
  }, [editor, changed, editing, loadId]);
  useEffect(() => registerUnitKeys(editor), [editor]);
  return null;
}
function registerUnitKeys(editor: LexicalEditor) {
  const remove = () => {
    const selection = $getSelection(); if (!$isNodeSelection(selection)) return false;
    const nodes = selection.getNodes().filter(node => node instanceof RawMarkdownNode);
    nodes.forEach(node => node.remove()); return nodes.length > 0;
  };
  const move = (event: KeyboardEvent | null, down: boolean) => {
    const selection = $getSelection(); if (!event?.altKey || !$isNodeSelection(selection)) return false;
    const nodes = selection.getNodes(); if (nodes.length !== 1) return false;
    const node = $getNodeByKey(nodes[0]!.getKey()); if (!(node instanceof RawMarkdownNode)) return false;
    const sibling = down ? node.getNextSibling() : node.getPreviousSibling();
    if (sibling) { if (down) sibling.insertAfter(node); else sibling.insertBefore(node); event.preventDefault(); }
    return true;
  };
  const off = [editor.registerCommand(KEY_BACKSPACE_COMMAND, remove, COMMAND_PRIORITY_HIGH), editor.registerCommand(KEY_DELETE_COMMAND, remove, COMMAND_PRIORITY_HIGH),
    editor.registerCommand(KEY_ARROW_UP_COMMAND, event => move(event, false), COMMAND_PRIORITY_HIGH), editor.registerCommand(KEY_ARROW_DOWN_COMMAND, event => move(event, true), COMMAND_PRIORITY_HIGH)];
  return () => off.forEach(unregister => unregister());
}
