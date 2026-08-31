import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangedLineDiff } from "./ChangedLineDiff.tsx";

test("renders only typed added and deleted lines with old and new numbers", () => {
  const html = renderToStaticMarkup(
    <ChangedLineDiff
      ariaLabel="Changed lines for src/app.ts"
      id="diff-src-app"
      lines={[
        { type: "deleted", old_line: 4, content: "const oldValue = true;" },
        { type: "added", new_line: 4, content: "const newValue = true;" },
      ]}
    />,
  );
  expect(html).toContain('data-line-type="deleted"');
  expect(html).toContain('data-line-type="added"');
  expect(html).toContain("const oldValue = true;");
  expect(html).toContain("const newValue = true;");
  expect(html).toContain(">4</span>");
});
