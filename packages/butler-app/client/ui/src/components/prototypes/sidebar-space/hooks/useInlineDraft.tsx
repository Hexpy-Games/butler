import { useEffect, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useMock } from "@/app/prototypes/sidebar-space/mock-store";
import type { DraftPart } from "@/app/prototypes/sidebar-space/mock-types";
import { isProjectConversation } from "@/app/prototypes/sidebar-space/sample-data";
import { SessionMention } from "../SessionMention";

export function useInlineDraft() {
  const editor = useRef<HTMLDivElement>(null);
  const caret = useRef<Range | null>(null);
  const lastSyncedDraft = useRef("");
  const draft = useMock((s) => s.draft);
  const reference = useMock((s) => s.reference);
  const active = useMock((s) => s.active);

  function rememberCaret() {
    const selection = window.getSelection();
    if (
      selection?.rangeCount &&
      editor.current?.contains(selection.anchorNode) &&
      editor.current.contains(selection.focusNode)
    ) {
      caret.current = selection.getRangeAt(0).cloneRange();
    }
  }

  function sync() {
    if (!editor.current) return;
    const parts: DraftPart[] = [];
    function read(node: Node) {
      if (node.nodeType === Node.TEXT_NODE)
        parts.push({ text: node.textContent ?? "" });
      else if (node instanceof HTMLElement) {
        if (node.dataset.mentionId) {
          parts.push({
            text: node.textContent ?? "",
            sessionId: node.dataset.mentionId,
          });
        } else if (node.tagName === "BR") parts.push({ text: "\n" });
        else {
          if (node.tagName === "DIV" && parts.length)
            parts.push({ text: "\n" });
          node.childNodes.forEach(read);
        }
      }
    }
    editor.current.childNodes.forEach(read);
    const text = parts.map((part) => part.text).join("");
    lastSyncedDraft.current = text;
    useMock.getState().syncDraft(text, parts);
    rememberCaret();
  }

  function insert(node: Node) {
    const root = editor.current;
    if (!root) return;
    root.focus();
    const range =
      caret.current && root.contains(caret.current.commonAncestorContainer)
        ? caret.current
        : document.createRange();
    if (range !== caret.current) {
      range.selectNodeContents(root);
      range.collapse(false);
    }
    range.deleteContents();
    const last = node instanceof DocumentFragment ? node.lastChild! : node;
    range.insertNode(node);
    range.setStartAfter(last);
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    sync();
  }

  useEffect(() => {
    const root = editor.current;
    if (root && lastSyncedDraft.current !== draft) {
      root.textContent = draft;
      caret.current = null;
      lastSyncedDraft.current = draft;
    }
  }, [draft, active]);

  useEffect(() => {
    if (!reference) return;
    const state = useMock.getState();
    const item = state.items.find((row) => row.id === reference);
    if (item) {
      const mention = document.createElement("span");
      mention.contentEditable = "false";
      mention.dataset.mentionId = item.id;
      // Static, escaped React markup only; pasted HTML never enters this editor.
      mention.innerHTML = renderToStaticMarkup(
        <SessionMention
          title={item.title}
          project={isProjectConversation(item, state.items)}
        />,
      );
      const fragment = document.createDocumentFragment();
      fragment.append(mention, document.createTextNode(" "));
      insert(fragment);
    }
    state.attach(null);
    // The request consumes current editor selection, not a render-time draft snapshot.
  }, [reference]);

  return { editor, rememberCaret, sync, insert };
}
