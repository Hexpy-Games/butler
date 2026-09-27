/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { FORCE_TARGET_CANDIDATES, forceStateCss, forceStateSelector, markForceTargets } from "./forceState";

const TARGET = "[data-ds-force-target]";
const HOVER = `:is([data-ds-force-state~="hover"] :is(${TARGET}, :has(${TARGET})))`;

describe("forced interaction states (data-ds-force-state)", () => {
  test("rewrites :hover in place so compound selectors keep their other parts", () => {
    expect(forceStateSelector(".button:hover:not(:disabled)")).toBe(`.button${HOVER}:not(:disabled)`);
    expect(forceStateSelector(".row:hover .actions")).toBe(`.row${HOVER} .actions`);
  });

  test("hover and active paint only the target and its ancestors, never sibling segments", () => {
    // Real :hover matches the element under the pointer and its ancestors; a
    // cell with several segments must not paint all of them.
    expect(HOVER).not.toContain('[data-ds-force-state~="hover"] *');
    expect(forceStateSelector(".segment:hover")).toBe(`.segment${HOVER}`);
  });

  test("maps :focus and :focus-visible to the one target element; :focus-within to it and its ancestors", () => {
    expect(forceStateSelector(".input:focus-visible")).toBe(`.input:is([data-ds-force-state~="focus-visible"] ${TARGET})`);
    expect(forceStateSelector(".input:focus")).toBe(`.input:is([data-ds-force-state~="focus-visible"] ${TARGET})`);
    expect(forceStateSelector(".group:focus-within")).toBe(
      `.group:is([data-ds-force-state~="focus-visible"] :is(${TARGET}, :has(${TARGET})))`,
    );
  });

  test("picks the first enabled focusable element as the target unless a story marks one", () => {
    expect(FORCE_TARGET_CANDIDATES).toContain("button:not(:disabled)");
    expect(FORCE_TARGET_CANDIDATES).toContain('[role="radio"]');
  });

  test("rewrites :active and every selector in a list", () => {
    expect(forceStateSelector(".a:active, .b:hover")).toBe(
      `.a:is([data-ds-force-state~="active"] :is(${TARGET}, :has(${TARGET}))), .b${HOVER}`,
    );
  });

  test("leaves selectors without interaction pseudo-classes alone", () => {
    expect(forceStateSelector(".button[data-variant=\"outline\"]")).toBeNull();
    expect(forceStateSelector(".link:hovered-like")).toBeNull();
  });

  test("builds a stylesheet that copies declarations and keeps @media wrappers", () => {
    const css = forceStateCss([
      { kind: "style", selector: ".button:hover", declarations: "background: var(--selection);" },
      { kind: "style", selector: ".plain", declarations: "color: red;" },
      { kind: "group", prelude: "@media (hover: hover)", rules: [{ kind: "style", selector: ".row:hover", declarations: "opacity: 1;" }] },
    ]);
    expect(css).toContain(`.button${HOVER} { background: var(--selection); }`);
    expect(css).not.toContain(".plain");
    expect(css).toContain(`@media (hover: hover) { .row${HOVER} { opacity: 1; } }`);
  });

  test("marks one target per cell: the first enabled segment, or the one a story marked", () => {
    const { document } = new JSDOM(`
      <div data-ds-force-state="hover" id="a"><button disabled>x</button><button>one</button><button>two</button></div>
      <div data-ds-force-state="hover" id="b"><button>one</button><button data-ds-force-target>two</button></div>`).window;
    markForceTargets(document);
    expect([...document.querySelectorAll("#a [data-ds-force-target]")].map((node) => node.textContent)).toEqual(["one"]);
    expect([...document.querySelectorAll("#b [data-ds-force-target]")].map((node) => node.textContent)).toEqual(["two"]);
  });
});
