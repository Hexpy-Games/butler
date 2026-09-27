/// <reference types="bun" />
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { ButlerThinkingMark } from "./ButlerThinkingMark";

function frame(markup: string) {
  return new JSDOM(markup).window.document.querySelector("[data-slot=aspect-frame]")!;
}

test("ButlerThinkingMark renders a decorative canvas in an icon-sized AspectFrame", () => {
  const mark = frame(renderToStaticMarkup(<ButlerThinkingMark size="sm" state="working" data-test-class="mark" />));
  expect(mark.getAttribute("aria-hidden")).toBe("true");
  expect(mark.getAttribute("data-size")).toBe("sm");
  expect(mark.getAttribute("data-mark-state")).toBe("working");
  expect(mark.getAttribute("data-test-class")).toBe("mark");
  expect(mark.querySelector("canvas")).not.toBeNull();
});

test("ButlerThinkingMark defaults to the idle logo and fills its container without a size", () => {
  const mark = frame(renderToStaticMarkup(<ButlerThinkingMark />));
  expect(mark.getAttribute("data-mark-state")).toBe("idle");
  expect(mark.getAttribute("data-size")).toBeNull();
});
