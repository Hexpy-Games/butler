// test-category: pure-logic
import { expect, test } from "bun:test";
import { createEditor, $getRoot, $isTextNode, $createParagraphNode, $createTextNode } from "lexical";
import { HeadingNode } from "@lexical/rich-text";
import { ListNode, ListItemNode } from "@lexical/list";
import { LinkNode } from "@lexical/link";
import { BlocksNode, ImageNode, RawMarkdownNode } from "./DocumentNodes";
import { importDocument, exportDocument, markDocumentChanges, type MarkdownSource } from "./documentMarkdown";
const fixture = '\n# Heading\n\nA **bold** and *italic* [link](https://example.org).\n\n- first\n- second\n\n1. one\n2. two\n\n```blocks\n{"v":2,"blocks":[{"type":"text","text":"Frozen"}]}\n```\n\n![alt](img_abcdefghij)\n\n> An unknown quote\n\n```toml\nvalue = 3\n```\n';
test("Markdown source survives import/export exactly and preserves unknown syntax beside edits", () => {
  const editor = createEditor({ namespace: "roundtrip", nodes: [HeadingNode, ListNode, ListItemNode, LinkNode, BlocksNode, ImageNode, RawMarkdownNode], onError: error => { throw error; } });
  let source: MarkdownSource;
  editor.update(() => { source = importDocument(fixture); }, { discrete: true });
  expect(editor.getEditorState().read(() => exportDocument(source))).toBe(fixture);
  editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
    editorState.read(() => markDocumentChanges(source, [...dirtyLeaves, ...[...dirtyElements].filter(([, intentional]) => intentional).map(([key]) => key)]));
  });
  editor.update(() => {
    const text = $getRoot().getFirstDescendant(); if ($isTextNode(text)) text.setTextContent("Edited heading");
  }, { discrete: true });
  const exported = editor.getEditorState().read(() => exportDocument(source));
  expect(exported).toBe(fixture.replace("# Heading", "# Edited heading"));
});

test("dirty descendants serialize only their top-level source slice; insert, move and delete keep raw siblings", () => {
  const editor = createEditor({ namespace: "source-order", nodes: [HeadingNode], onError: error => { throw error; } });
  let source: MarkdownSource;
  editor.update(() => { source = importDocument("#  Raw heading\n\nUntouched paragraph.\n\nLast paragraph\n"); }, { discrete: true });
  editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
    editorState.read(() => markDocumentChanges(source, [...dirtyLeaves, ...[...dirtyElements].filter(([, intentional]) => intentional).map(([key]) => key)]));
  });
  editor.update(() => {
    const root = $getRoot(), heading = root.getFirstChild()!;
    root.getLastChild()!.insertBefore(heading);
    root.getLastChild()!.remove();
    root.append($createParagraphNode().append($createTextNode("Added")));
  }, { discrete: true });
  expect(editor.getEditorState().read(() => exportDocument(source))).toBe("Untouched paragraph.\n\n#  Raw heading\n\nAdded");
  expect(editor.getEditorState().read(() => exportDocument(source))).toBe("Untouched paragraph.\n\n#  Raw heading\n\nAdded");
});
