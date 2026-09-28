import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { easingPath, linearStops } from "./easingPath";
import { FOUNDATION_HERO_VARIANTS } from "./FoundationHeroMotion";
import FoundationHeroStage, { FOUNDATION_HERO_RENDERERS } from "./FoundationHeroStage";
import { flipScales, pingPong, slotStyle } from "./heroSequence";

const stageCss = readFileSync(new URL("./FoundationHeroMotion.module.css", import.meta.url), "utf8");
const variantCss = readFileSync(new URL("./heroVariants.module.css", import.meta.url), "utf8");

function hero(markup: string) {
  const dom = new JSDOM(markup);
  return { dom, node: dom.window.document.querySelector("[data-slot='foundation-hero']")! };
}

describe("FoundationHeroMotion", () => {
  const saved = { document: globalThis.document, window: globalThis.window };
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
      else Object.assign(globalThis, { [key]: value });
    }
  });

  test("the registry has one renderer per variant and every variant draws a decorative stage", () => {
    expect(Object.keys(FOUNDATION_HERO_RENDERERS).sort()).toEqual([...FOUNDATION_HERO_VARIANTS].sort());
    for (const variant of FOUNDATION_HERO_VARIANTS) {
      const { dom, node } = hero(renderToStaticMarkup(<FoundationHeroStage variant={variant} />));
      expect(node.getAttribute("data-hero-variant")).toBe(variant);
      expect(node.getAttribute("aria-hidden")).toBe("true");
      expect(node.children.length).toBeGreaterThan(0);
      expect(node.querySelector("button, a, input, [tabindex]")).toBeNull();
      dom.window.close();
    }
  });

  test("the exported shell loads the graphics on demand, keeping them out of the app bundle", () => {
    const shell = readFileSync(new URL("./FoundationHeroMotion.tsx", import.meta.url), "utf8");
    expect(shell).toContain('lazy(() => import("./FoundationHeroStage"))');
    expect(shell).not.toMatch(/^import .*(?:\.css|heroes\/|FoundationHeroStage)/mu);
  });

  test("still, and reduced motion from the DS scope, render the poster state", () => {
    const { dom, node } = hero(renderToStaticMarkup(<FoundationHeroStage variant="motion" still />));
    expect(node.getAttribute("data-hero-state")).toBe("still");
    dom.window.close();

    const page = new JSDOM("<body data-motion=\"reduced\"></body>");
    Object.assign(globalThis, { document: page.window.document, window: page.window });
    const reduced = hero(renderToStaticMarkup(<FoundationHeroStage variant="spacing" />));
    expect(reduced.node.getAttribute("data-hero-state")).toBe("still");
    reduced.dom.window.close();
    page.window.close();
  });

  test("still stops every animation and reduced motion stops them without JS too", () => {
    expect(stageCss).toMatch(/\.stage\[data-hero-state="still"\] \* \{\s*animation: none;/u);
    expect(stageCss).toMatch(/\.stage\[data-hero-state="paused"\] \* \{\s*animation-play-state: paused;/u);
    expect(stageCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.stage \* \{\s*animation: none;/u);
  });

  test("keyframes move only transform and opacity, and never ease inside a keyframe", () => {
    for (const css of [stageCss, variantCss]) {
      const keyframes = css.slice(css.indexOf("@keyframes"));
      const properties = new Set([...keyframes.matchAll(/^\s+([a-z-]+):/gmu)].map((match) => match[1]));
      expect([...properties].sort()).toEqual(["opacity", "transform"]);
    }
  });

  test("each slot element enters from its neighbour's geometry", () => {
    expect(pingPong(4)).toEqual([0, 1, 2, 3, 2, 1]);
    expect(pingPong(9)).toHaveLength(16);
    const flips = flipScales([24, 28, 30, 34], pingPong(4));
    expect(flips[1]).toEqual({ size: 28, from: "scale(0.857)", to: "scale(1.071)" });
    expect(flips[0]!.from).toBe("scale(1.167)");
    expect(slotStyle(6, 2, { rest: "translateY(4px)" })).toMatchObject({ "--k": 2, "--hero-slots": 6, "--from": "translateY(4px)", "--to": "translateY(4px)" });
  });
});

describe("easingPath", () => {
  test("draws cubic-bezier and linear tokens in a 100x100 box", () => {
    expect(easingPath("cubic-bezier(0.2, 0, 0, 1)")).toBe("M0 100 C20 100 0 0 100 0");
    expect(easingPath("linear")).toBe("M0 100 L100 0");
    expect(easingPath("steps(4)")).toBeNull();
  });

  test("reads linear() stops like CSS: even spread, one or two percentages", () => {
    expect(linearStops("0, 0.5, 1")).toEqual([[0, 0], [0.5, 0.5], [1, 1]]);
    expect(linearStops("0, 1.1 60%, 1")).toEqual([[0, 0], [0.6, 1.1], [1, 1]]);
    expect(linearStops("0, 0.9 20% 40%, 1")).toEqual([[0, 0], [0.2, 0.9], [0.4, 0.9], [1, 1]]);
    expect(easingPath("linear(0, 1.2 50%, 1)")).toBe("M0 100 L50 -20 L100 0");
  });
});
