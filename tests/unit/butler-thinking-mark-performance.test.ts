import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(
    import.meta.dir,
    "../../packages/butler-app/client/ui/src/components/common/ButlerThinkingMark.tsx",
  ),
  "utf8",
);

test("thinking mark keeps layout reads outside its animation frame", () => {
  const renderFrame = source.slice(
    source.indexOf("const render ="),
    source.indexOf("const tick ="),
  );

  expect(source).toContain("const resizeAndRender = () =>");
  expect(renderFrame).not.toContain("resize();");
});

test("thinking mark stops background work without waking sibling marks", () => {
  expect(source).toContain(
    'document.addEventListener("visibilitychange", handleVisibilityChange)',
  );
  expect(source).not.toContain("butler-thinking-mark-state-change");
});
