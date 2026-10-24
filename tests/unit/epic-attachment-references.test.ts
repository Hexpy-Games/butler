// test-category: pure-logic
import { expect, test } from "bun:test";
import { epicAttachmentReferences } from "../../packages/butler-app/client/ui/src/components/canon/epicAttachmentReferences.ts";

test("attachment references follow Markdown links, images and definitions", () => {
  const markdown = "[문서](attachment:doc) ![이미지](attachment:image) [검토][file]\n\n[file]: attachment:review\n[unused]: attachment:unused";
  expect([...epicAttachmentReferences(markdown)]).toEqual(["doc", "image", "review"]);
});

test("plain strings, escaped links and code never retain a deleted attachment pill", () => {
  const markdown = "attachment:plain `attachment:code` `[code](attachment:inline)`\n\n```md\n[file](attachment:block)\n```\n\n\\[escaped](attachment:escaped)";
  expect([...epicAttachmentReferences(markdown)]).toEqual([]);
  expect([...epicAttachmentReferences("[검토](attachment:review)")]).toEqual(["review"]);
  expect([...epicAttachmentReferences("검토")]).toEqual([]);
});
