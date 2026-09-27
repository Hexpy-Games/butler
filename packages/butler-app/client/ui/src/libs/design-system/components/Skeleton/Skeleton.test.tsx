/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { Skeleton } from "./index";

const css = readFileSync(new URL("./Skeleton.module.css", import.meta.url), "utf8");

function render(node: React.ReactElement) {
  return new JSDOM(renderToStaticMarkup(node)).window.document;
}

test("width and height are token-backed props, not inline styles", () => {
  const document = render(<Skeleton width="2/5" height="title" />);
  const skeleton = document.querySelector('[data-slot="skeleton"]')!;
  expect(skeleton.getAttribute("data-width")).toBe("2/5");
  expect(skeleton.getAttribute("data-height")).toBe("title");
  expect(skeleton.getAttribute("style")).toBeNull();
  expect(css).toMatch(/\[data-height="row"\]\s*\{\s*height:\s*var\(--touch-target\)/u);
  expect(css).toMatch(/\[data-width="1\/2"\]\s*\{\s*width:\s*50%/u);
});

test("a numeric width is measured in characters", () => {
  const skeleton = render(<Skeleton width={12} />).querySelector('[data-slot="skeleton"]')!;
  expect(skeleton.getAttribute("data-width")).toBe("ch");
  expect(skeleton.getAttribute("style")).toContain("--skeleton-width:12ch");
});

test("lines renders a paragraph with the DS width ramp and one label", () => {
  const document = render(<Skeleton lines={3} height="line" label="Preparing" />);
  const group = document.querySelector('[data-slot="skeleton-lines"]')!;
  const lines = [...group.querySelectorAll('[data-slot="skeleton"]')];
  expect(lines.map((line) => line.getAttribute("data-width"))).toEqual(["paragraph-1", "paragraph-2", "paragraph-last"]);
  expect(lines.every((line) => line.getAttribute("data-height") === "line")).toBe(true);
  expect(group.getAttribute("role")).toBe("status");
  expect(document.querySelectorAll(".sr-only")).toHaveLength(1);
});

test("shape rounds the placeholder", () => {
  expect(render(<Skeleton shape="circle" width={2} />).querySelector('[data-slot="skeleton"]')!.getAttribute("data-shape")).toBe("circle");
});
