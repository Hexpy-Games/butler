import { $addUpdateTag, $getNodeByKey, $getSelection, $insertNodes, $isRangeSelection, $isTextNode, HISTORY_PUSH_TAG, type LexicalEditor, type LexicalNode } from "lexical";

/** The `@` word the caret is in: `@` at the start of a text run or after whitespace, then non-space text. */
export interface MentionToken {
  key: string;
  /** Offset of the `@` in the text node. */
  start: number;
  /** The caret offset; the query is the text between. */
  end: number;
  query: string;
}

const TOKEN = /(?:^|\s)@([^\s@]*)$/u;

export function $mentionToken(): MentionToken | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const node = selection.anchor.getNode();
  if (!$isTextNode(node)) return null;
  const end = selection.anchor.offset;
  const match = TOKEN.exec(node.getTextContent().slice(0, end));
  if (!match) return null;
  const query = match[1] ?? "";
  return { key: node.getKey(), start: end - query.length - 1, end, query };
}

export const sameToken = (a: MentionToken | null, b: MentionToken | null) =>
  a?.key === b?.key && a?.start === b?.start && a?.end === b?.end && a?.query === b?.query;

/** Where the `@` is drawn, for anchoring the menu; the editor's box when it is not in the DOM. */
export function mentionAnchorRect(editor: LexicalEditor, token: MentionToken): DOMRect {
  const text = editor.getElementByKey(token.key)?.firstChild;
  if (!text || text.nodeType !== Node.TEXT_NODE || (text.textContent?.length ?? 0) <= token.start) {
    return editor.getRootElement()?.getBoundingClientRect() ?? new DOMRect();
  }
  const range = document.createRange();
  range.setStart(text, token.start);
  range.setEnd(text, token.start + 1);
  return range.getBoundingClientRect();
}

/** Replaces the `@query` text with the reference node and a following space, as one undo step. */
export function replaceMentionToken(editor: LexicalEditor, token: MentionToken, create: () => LexicalNode): void {
  editor.update(() => {
    const node = $getNodeByKey(token.key);
    if (!$isTextNode(node) || node.getTextContent().slice(token.start, token.end) !== `@${token.query}`) return;
    const spaced = /^\s/u.test(node.getTextContent().slice(token.end));
    node.select(token.start, token.end);
    $insertNodes([create()]);
    const selection = $getSelection();
    if (!spaced && $isRangeSelection(selection)) selection.insertText(" ");
    $addUpdateTag(HISTORY_PUSH_TAG);
  });
  editor.focus();
}
