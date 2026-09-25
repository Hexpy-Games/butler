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
