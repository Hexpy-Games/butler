/// <reference types="bun" />
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { Tabs, TabsList, TabsTrigger } from "./Tabs";

const css = readFileSync(new URL("./Tabs.module.css", import.meta.url), "utf8");

test("line tabs mark the active trigger with a paint-only accent underline", () => {
  const markup = renderToStaticMarkup(
    <Tabs defaultValue="a"><TabsList variant="line"><TabsTrigger value="a">A</TabsTrigger><TabsTrigger value="b">B</TabsTrigger></TabsList></Tabs>,
  );
  const list = new JSDOM(markup).window.document.querySelector('[data-slot="tabs-list"]')!;
  expect(list.getAttribute("data-variant")).toBe("line");
  const rule = /\.variant-line \.trigger\[data-state="active"\]\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";
  expect(rule).toMatch(/box-shadow:\s*inset 0 calc\(-1 \* var\(--border-width-strong\)\) 0 var\(--accent\)/u);
  expect(rule).toMatch(/background:\s*transparent/u);
});

test("Tabs gap separates the list from panels with named spacing; line triggers never shrink", () => {
  const markup = renderToStaticMarkup(<Tabs defaultValue="a" gap="2xl"><TabsList><TabsTrigger value="a">A</TabsTrigger></TabsList></Tabs>);
  const root = new JSDOM(markup).window.document.querySelector('[data-slot="tabs"]')!;
  expect(root.getAttribute("data-gap")).toBe("2xl");
  expect(css).toMatch(/\.root\[data-gap="2xl"\]\s*\{\s*gap:\s*var\(--space-2xl\)/u);
  expect(/\.variant-line \.trigger\s*\{([^}]*)\}/u.exec(css)![1]).toMatch(/flex-shrink:\s*0/u);
});

test("line tabs render one sliding indicator that moves on the compositor and sits a token below the label", () => {
  const markup = renderToStaticMarkup(
    <Tabs defaultValue="a"><TabsList variant="line"><TabsTrigger value="a">A</TabsTrigger><TabsTrigger value="b">B</TabsTrigger></TabsList></Tabs>,
  );
  const document = new JSDOM(markup).window.document;
  expect(document.querySelectorAll('[data-slot="tabs-indicator"]')).toHaveLength(1);
  expect(document.querySelector('[data-slot="tabs-indicator"]')!.getAttribute("aria-hidden")).toBe("true");
  const plain = renderToStaticMarkup(<Tabs defaultValue="a"><TabsList><TabsTrigger value="a">A</TabsTrigger></TabsList></Tabs>);
  expect(plain).not.toContain("tabs-indicator");
  const indicator = /\.indicator\s*\{([^}]*)\}/u.exec(css)?.[1] ?? "";
  expect(indicator).toMatch(/transition:\s*transform var\(--motion-base\) var\(--motion-ease-decelerate\)/u);
  expect(indicator).not.toMatch(/transition:[^;]*(width|left)/u);
  expect(/\.variant-line \.trigger\s*\{([^}]*)\}/u.exec(css)![1]).toMatch(/padding-block:\s*var\(--space-xs\) var\(--tabs-line-indicator-gap\)/u);
  // Once measured, the indicator replaces the static underline fallback.
  expect(css).toMatch(/\.variant-line\[data-indicator-ready\] \.trigger\[data-state="active"\]\s*\{\s*box-shadow:\s*none/u);
});
