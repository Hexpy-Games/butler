// test-category: pure-logic
import { describe, expect, test } from "bun:test";
import { mergeDocument } from "./documentMerge";
import { exportDocumentMarkdown, documentFileName } from "./documentExport";
describe("document merge", () => {
  test("independent edits, additions, deletions and conflicts preserve local text", () => {
    expect(mergeDocument("a\nb\nc\n", "mine\nb\nc\n", "a\nb\ntheirs\n")).toBe("mine\nb\ntheirs\n");
    expect(mergeDocument("a\nb\n", "mine\nb\n", "theirs\nb\n")).toBe("mine\nb\n");
    expect(mergeDocument("a\nb\nc", "a\nc", "a\nb\nc\nnew")).toBe("a\nc\nnew");
    expect(mergeDocument("a\nb\nc", "a\nnew\nb\nc", "a\nb\nother")).toBe("a\nnew\nb\nother");
    expect(mergeDocument("", "mine", "theirs")).toBe("mine");
  });
  test("disjoint repeated lines and distant hunks remain complete", () => {
    const base = "x\na\nx\nb\nx\nc\n";
    expect(mergeDocument(base, "x\nA\nx\nb\nx\nC\n", "x\na\nx\nB\nx\nc\n")).toBe("x\nA\nx\nB\nx\nC\n");
  });
});
test("Markdown export renders fences and inlines stored images without altering surrounding syntax", async () => {
  const spec = { v: 2, blocks: [{ type: "table", columns: ["A", "B"], rows: [["one", "two"]] }] };
  const raw = `# Heading\n\n**bold**\n\n\`\`\`blocks\n${JSON.stringify(spec)}\n\`\`\`\n\n![alt](img_abcdefghij)\n`;
  expect(await exportDocumentMarkdown(raw, async () => "data:image/jpeg;base64,abc")).toBe("# Heading\n\n**bold**\n\n| A | B |\n| --- | --- |\n| one | two |\n\n![alt](data:image/jpeg;base64,abc)\n");
  expect(documentFileName("a/b:c?")).toBe("a_b_c_");
});

test("image destinations are inlined without replacing the same id in alt text or title", async () => {
  expect(await exportDocumentMarkdown('![img_abcdefghij](img_abcdefghij "img_abcdefghij")', async () => "data:image/jpeg;base64,abc"))
    .toBe('![img_abcdefghij](data:image/jpeg;base64,abc "img_abcdefghij")');
});
