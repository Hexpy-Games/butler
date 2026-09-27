import { describe, expect, test } from "bun:test";
import { codeToHtml } from "shiki";
import { SYNTAX_ROLE, syntaxTheme, syntaxRoleTransformer } from "./highlight";

async function highlight(code: string, lang: string) {
  return codeToHtml(code, { lang, theme: syntaxTheme, transformers: [syntaxRoleTransformer] });
}

describe("syntax role highlighting", () => {
  test("maps token colors to data-syntax roles and drops inline styles", async () => {
    const html = await highlight('# verify\nshasum -a 256 -c "file.sha256"', "bash");
    expect(html).toContain('data-syntax="comment"');
    expect(html).toContain('data-syntax="string"');
    expect(html).not.toContain("style=");
    expect(html).not.toContain("--shiki");
  });

  test("every role maps onto a --syntax-* token name", () => {
    for (const role of new Set(Object.values(SYNTAX_ROLE))) {
      expect(["keyword", "string", "comment", "number", "title", "type", "variable", "meta", "addition", "deletion"])
        .toContain(role);
    }
  });
});
