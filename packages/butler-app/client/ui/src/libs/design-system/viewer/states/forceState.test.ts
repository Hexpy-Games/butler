/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { forceStateCss, forceStateSelector } from "./forceState";

const HOVER = ':is([data-ds-force-state~="hover"], [data-ds-force-state~="hover"] *)';

describe("forced interaction states (data-ds-force-state)", () => {
  test("rewrites :hover in place so compound selectors keep their other parts", () => {
    expect(forceStateSelector(".button:hover:not(:disabled)")).toBe(`.button${HOVER}:not(:disabled)`);
    expect(forceStateSelector(".row:hover .actions")).toBe(`.row${HOVER} .actions`);
  });

  test("maps :focus and :focus-visible to focusable elements inside the forced cell", () => {
    const rewritten = forceStateSelector(".input:focus-visible");
    expect(rewritten).toContain('[data-ds-force-state~="focus-visible"]');
    expect(rewritten).toContain("button");
    expect(forceStateSelector(".input:focus")).toContain('[data-ds-force-state~="focus-visible"]');
    expect(forceStateSelector(".group:focus-within")).toContain('[data-ds-force-state~="focus-visible"]');
  });

  test("rewrites :active and every selector in a list", () => {
    expect(forceStateSelector(".a:active, .b:hover")).toBe(
      `.a:is([data-ds-force-state~="active"], [data-ds-force-state~="active"] *), .b${HOVER}`,
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
});
