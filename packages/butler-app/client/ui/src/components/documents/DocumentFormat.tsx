import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { $getSelection, $isRangeSelection, $isElementNode, $setSelection, type RangeSelection, FORMAT_TEXT_COMMAND, KEY_ESCAPE_COMMAND, COMMAND_PRIORITY_LOW } from "lexical";
import { $createHeadingNode, $isHeadingNode } from "@lexical/rich-text";
import { $createParagraphNode } from "lexical";
import { INSERT_UNORDERED_LIST_COMMAND, REMOVE_LIST_COMMAND, $isListNode } from "@lexical/list";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { Bold, Heading, ListBullet, Plus, DocumentFormatBar, Dialog, DialogContent, DialogTitle, Input, Button, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { useLibraryItems } from "../library/libraryApi";
import { BlocksNode } from "./DocumentNodes";
import type { LibraryItem } from "../browser/libraryStore";
export function DocumentFormat() {
  const [editor] = useLexicalComposerContext();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [formats, setFormats] = useState({ bold: false, heading: false, list: false });
  const [adding, setAdding] = useState(false);
  const savedSelection = useRef<RangeSelection | null>(null);
  const copy = appCopy.documents;
  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed() || !editor.isEditable()) { setAnchor(null); return; }
      const dom = window.getSelection();
      setAnchor(dom?.rangeCount ? dom.getRangeAt(0).getBoundingClientRect() : null);
      const top = selection.anchor.getNode().getTopLevelElement();
      setFormats({ bold: selection.hasFormat("bold"), heading: $isHeadingNode(top), list: $isListNode(top) });
    });
  }), [editor]);
  useEffect(() => editor.registerCommand(KEY_ESCAPE_COMMAND, event => {
    if (!anchor || adding) return false;
    const selection = $getSelection();
    if ($isRangeSelection(selection)) selection.anchor.set(selection.focus.key, selection.focus.offset, selection.focus.type);
    setAnchor(null); event.preventDefault(); return true;
  }, COMMAND_PRIORITY_LOW), [editor, anchor, adding]);
  const heading = () => editor.update(() => {
    const selection = $getSelection(); if (!$isRangeSelection(selection)) return;
    const top = selection.anchor.getNode().getTopLevelElement();
    if (!top || !$isElementNode(top) || $isListNode(top)) return;
    const next = $isHeadingNode(top) ? $createParagraphNode() : $createHeadingNode("h2");
    next.append(...top.getChildren()); top.replace(next); next.selectEnd();
  });
  const insert = (item: LibraryItem) => {
    editor.update(() => {
      const selection = savedSelection.current?.clone() ?? $getSelection();
      $setSelection(selection);
      if (!$isRangeSelection(selection) || !item.block) return;
      const top = selection.anchor.getNode().getTopLevelElement();
      const raw = `\`\`\`blocks\n${JSON.stringify(item.block, (key, value) => key === "image_url" ? undefined : value)}\n\`\`\``;
      top?.insertAfter(new BlocksNode(raw));
    });
    setAdding(false); editor.focus();
  };
  return <>{createPortal(<DocumentFormatBar anchor={adding ? null : anchor} label={copy.format} actions={[
    { id: "bold", label: copy.bold, icon: <Bold size="sm" />, pressed: formats.bold, onPress: () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold") },
    { id: "heading", label: copy.heading, icon: <Heading size="sm" />, pressed: formats.heading, onPress: heading },
    { id: "list", label: copy.list, icon: <ListBullet size="sm" />, pressed: formats.list, onPress: () => editor.dispatchCommand(formats.list ? REMOVE_LIST_COMMAND : INSERT_UNORDERED_LIST_COMMAND, undefined) },
    { id: "block", label: copy.addBlock, icon: <Plus size="sm" />, onPress: () => { editor.getEditorState().read(() => { const selection = $getSelection(); if ($isRangeSelection(selection)) savedSelection.current = selection.clone(); }); setAdding(true); } },
  ]} />, document.body)}<Dialog open={adding} onOpenChange={setAdding}><DialogContent><DialogTitle>{copy.addBlock}</DialogTitle>
    {adding ? <BlockPicker onSelect={insert} /> : null}
  </DialogContent></Dialog></>;
}
function BlockPicker({ onSelect }: { onSelect: (item: LibraryItem) => void }) {
  const [q, setQ] = useState("");
  const page = useLibraryItems({ kind: "scrap", q });
  return <Stack gap="sm"><Input aria-label={appCopy.library.search} placeholder={appCopy.library.search} value={q} onChange={event => setQ(event.target.value)} />
    {page.items.filter(item => item.block).map(item => <Button key={item.id} variant="ghost" onClick={() => onSelect(item)}>{item.title}</Button>)}
    {page.next ? <Button variant="ghost" onClick={page.more}>{appCopy.library.loadMore}</Button> : null}
  </Stack>;
}
