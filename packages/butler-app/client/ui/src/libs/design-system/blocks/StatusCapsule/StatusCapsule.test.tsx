/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusCapsule } from "./StatusCapsule";

const css = readFileSync(new URL("./StatusCapsule.module.css", import.meta.url), "utf8");

test("StatusCapsule orders title, detail and progress in a glass pill and caps each part with tokens", () => {
  const html = renderToStaticMarkup(
    <StatusCapsule icon={<i />} title="Review the activity surface" detail="Validating" progress="2/3"
      partTestClasses={{ title: "t", detail: "d", progress: "p" }} aria-label="Review · Validating · 2/3" />,
  );
  expect(html).toContain('data-shape="pill"');
  expect(html.indexOf('data-test-class="t"')).toBeLessThan(html.indexOf('data-test-class="d"'));
  expect(html.indexOf('data-test-class="d"')).toBeLessThan(html.indexOf('data-test-class="p"'));
  expect(html).toContain(">2/3<");
  expect(html).not.toContain("style=");
  expect(css).toContain("max-width: var(--status-capsule-title-max)");
  expect(css).toContain("max-width: var(--status-capsule-detail-max)");
});
