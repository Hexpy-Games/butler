/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { freezePopperOnExit, POPPER_EXIT_FROZEN_ATTRIBUTE, POPPER_EXIT_ORIGIN_VAR, POPPER_EXIT_TRANSFORM_VAR } from "./popperExit";

const dsRoot = join(import.meta.dir, "..");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount() {
  const dom = new JSDOM("<div data-radix-popper-content-wrapper style=\"transform: translate(588px, 354px); --radix-popper-transform-origin: 530px 392px\"><div data-state=\"open\"></div></div>");
  Object.assign(globalThis, { MutationObserver: dom.window.MutationObserver });
  const wrapper = dom.window.document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]")!;
  return { wrapper, content: wrapper.firstElementChild as HTMLElement };
}

test("closing pins the popper wrapper to its last anchored position", async () => {
  const { wrapper, content } = mount();
  const cleanup = freezePopperOnExit(content);
  expect(wrapper.hasAttribute(POPPER_EXIT_FROZEN_ATTRIBUTE)).toBe(false);
  content.dataset.state = "closed";
  await flush();
  expect(wrapper.hasAttribute(POPPER_EXIT_FROZEN_ATTRIBUTE)).toBe(true);
  expect(wrapper.style.getPropertyValue(POPPER_EXIT_TRANSFORM_VAR)).toBe("translate(588px, 354px)");
  // The anchor detaches mid-exit and floating-ui repositions to the viewport origin.
  expect(wrapper.style.getPropertyValue(POPPER_EXIT_ORIGIN_VAR)).toBe("530px 392px");
  wrapper.style.transform = "translate(0px, 10px)";
  wrapper.style.setProperty("--radix-popper-transform-origin", "0px 0px");
  await flush();
  expect(wrapper.style.getPropertyValue(POPPER_EXIT_TRANSFORM_VAR)).toBe("translate(588px, 354px)");
  expect(wrapper.style.getPropertyValue(POPPER_EXIT_ORIGIN_VAR)).toBe("530px 392px");
  content.dataset.state = "open";
  await flush();
  expect(wrapper.hasAttribute(POPPER_EXIT_FROZEN_ATTRIBUTE)).toBe(false);
  if (typeof cleanup === "function") cleanup();
});

test("the frozen exit position overrides the inline popper transform", () => {
  const css = readFileSync(join(dsRoot, "overlay-exit.css"), "utf8");
  expect(css).toMatch(/\[data-radix-popper-content-wrapper\]\[data-exit-frozen\]\s*\{\s*transform:\s*var\(--popper-exit-transform\)\s*!important;\s*--radix-popper-transform-origin:\s*var\(--popper-exit-origin\)\s*!important;/u);
  expect(readFileSync(join(dsRoot, "tokens.css"), "utf8")).toContain('@import url("./overlay-exit.css");');
});

test("every popper overlay content freezes its position on exit", () => {
  for (const file of ["popover.tsx", "dropdown-menu.tsx", "context-menu.tsx", "select.tsx"]) {
    expect(readFileSync(join(dsRoot, "shadcn/ui", file), "utf8")).toContain("usePopperExitFreezeRef");
  }
});

test("overlay exit keyframes shrink and fade in place without travel", () => {
  const files = ["components/Popover/Popover.module.css", "components/DropdownMenu/DropdownMenu.module.css", "components/ContextMenu/ContextMenu.module.css", "shadcn/ui/tooltip.module.css", "components/Presence/Presence.module.css"];
  for (const file of files) {
    const css = readFileSync(join(dsRoot, file), "utf8");
    const exits = [...css.matchAll(/@keyframes [\w-]*exit\s*\{([\s\S]*?)\n\}/gu)].map((match) => match[1]);
    expect(exits.length).toBeGreaterThan(0);
    for (const body of exits) expect(body).not.toMatch(/translate/u);
  }
});
