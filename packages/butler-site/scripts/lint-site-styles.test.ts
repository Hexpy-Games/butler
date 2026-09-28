import { describe, expect, test } from "bun:test";
import { lintCss, lintMarkup, lintSite } from "./lint-site-styles";

const known = new Set(["--text-primary", "--space-sm", "--typo-body-size", "--font-body"]);
const reasons = (findings: Array<{ rule: string }>) => findings.map((finding) => finding.rule);

describe("lintCss outside tokens.css", () => {
  const lint = (source: string) => lintCss("src/ds/components/X/X.module.css", source, { knownTokens: known });

  test("accepts token-only declarations", () => {
    expect(lint(".x { color: var(--text-primary); padding: var(--space-sm); }")).toEqual([]);
  });

  test("rejects raw colors in any form", () => {
    expect(reasons(lint(".x { color: #fff; }"))).toEqual(["raw-color"]);
    expect(reasons(lint(".x { background: rgba(0, 0, 0, 0.1); }"))).toEqual(["raw-color"]);
    expect(reasons(lint(".x { color: hsl(0 0% 0%); }"))).toEqual(["raw-color"]);
    expect(reasons(lint(".x { border-color: white; }"))).toEqual(["raw-color"]);
    expect(reasons(lint(".x { --local: black; }"))).toEqual(["raw-color"]);
  });

  test("does not mistake names containing white/black for colors", () => {
    expect(lint(".x { white-space: nowrap; }")).toEqual([]);
  });

  test("rejects raw typography values", () => {
    expect(reasons(lint(".x { font-size: 14px; }"))).toEqual(["raw-font"]);
    expect(reasons(lint(".x { font-family: serif; }"))).toEqual(["raw-font"]);
    expect(reasons(lint(".x { font-weight: 600; }"))).toEqual(["raw-font"]);
    expect(reasons(lint(".x { font: 12px/1 sans-serif; }"))).toEqual(["raw-font"]);
    expect(lint(".x { font: inherit; font-size: var(--typo-body-size); font-family: var(--font-body); }")).toEqual([]);
  });

  test("ignores comments", () => {
    expect(lint("/* color: #fff; font-size: 12px */ .x { color: var(--text-primary); }")).toEqual([]);
  });

  test("rejects var() references to unknown tokens unless a fallback is given", () => {
    expect(reasons(lint(".x { color: var(--nope); }"))).toEqual(["unknown-token"]);
    expect(lint(".x { height: var(--row-height, var(--space-sm)); }")).toEqual([]);
    expect(lint(".x { --local-gap: var(--space-sm); gap: var(--local-gap); }")).toEqual([]);
  });
});

describe("lintCss in tokens.css", () => {
  const lint = (source: string) => lintCss("src/ds/tokens.css", source, { knownTokens: known, isTokens: true });

  test("allows raw values in token definitions but hex only in palette tokens", () => {
    expect(lint(":root { --grayscale-01: #f8f9fa; --shadow: 0 1px 3px rgba(0, 0, 0, 0.2); }")).toEqual([]);
    expect(lint(":root { --web-palette-ink: #0a0a0b; --typo-h1-size: 32px; }")).toEqual([]);
    expect(reasons(lint(":root { --web-header-bg: #ffffff; }"))).toEqual(["raw-hex-token"]);
  });
});

describe("ordered list markers", () => {
  test("rejects circled-number characters in content and styles", () => {
    expect(reasons(lintMarkup("a.mdx", "1. 언어\n\u2461 안전고지"))).toEqual(["circled-number"]);
    expect(reasons(lintMarkup("a.mdx", "\u2776 dingbat"))).toEqual(["circled-number"]);
    const css = lintCss("a.module.css", '.x::before { content: "\u2460"; }', { knownTokens: known });
    expect(reasons(css)).toContain("circled-number");
    expect(lintMarkup("a.mdx", "1. 언어\n2. 안전고지")).toEqual([]);
  });

  test("rejects custom counter badges; ordered lists keep native markers", () => {
    const css = ".x li::before { content: counter(step); }";
    expect(reasons(lintCss("a.module.css", css, { knownTokens: known }))).toEqual(["custom-counter"]);
  });
});

describe("list spacing", () => {
  const lint = (source: string) => lintCss("src/ds/web/X/X.module.css", source, { knownTokens: known });

  test("ul and ol share every spacing rule", () => {
    expect(reasons(lint(".x :where(ol) { margin-top: var(--space-sm); }"))).toEqual(["list-spacing"]);
    expect(reasons(lint(".x :where(ul) { padding-left: var(--space-sm); }"))).toEqual(["list-spacing"]);
    expect(reasons(lint(".x :where(ol > li + li) { margin-top: var(--space-sm); }"))).toEqual(["list-spacing"]);
    expect(lint(".x :where(ul, ol) { padding-left: var(--space-sm); }")).toEqual([]);
    expect(lint(".x :where(li > ul, li > ol) { margin-top: var(--space-sm); }")).toEqual([]);
  });

  test("list markers may differ", () => {
    expect(lint(".x :where(ol) { list-style: decimal; }")).toEqual([]);
    expect(lint(".x :where(ul > li)::marker { color: var(--text-primary); }")).toEqual([]);
  });

  test("list margin resets have zero specificity, so they never outrank the flow spacing", () => {
    // The regression: this reset tied `.x > :where(*) + :where(*)` and, coming later, zeroed every list's top margin.
    expect(reasons(lint(".x :where(ul, ol) { margin-block: 0; padding-left: var(--space-sm); }"))).toEqual(["list-spacing"]);
    expect(reasons(lint(".x :where(p, ul, ol) { margin: 0; }"))).toEqual(["list-spacing"]);
    expect(reasons(lint(".x > :where(ul, ol) { margin-top: 0; }"))).toEqual(["list-spacing"]);
    expect(lint(":where(.x) :where(p, ul, ol) { margin-block: 0; }")).toEqual([]);
    expect(lint(".x :where(p, ul, ol) + :where(p, ul, ol) { margin-top: var(--space-sm); }")).toEqual([]);
  });

  test("reports the rule's first line and ignores lookalike names", () => {
    const findings = lint(".a { color: var(--text-primary); }\n\n.x :where(ol) {\n  margin-top: var(--space-sm);\n}");
    expect(findings.map((finding) => [finding.rule, finding.line])).toEqual([["list-spacing", 3]]);
    expect(lint(".tool, .ol-row, .x-ul { margin: 0; }")).toEqual([]);
  });

  test("checks rules nested in at-rules", () => {
    expect(reasons(lint("@media (width > 640px) {\n  .x :where(ol) { margin-top: var(--space-sm); }\n}"))).toEqual(["list-spacing"]);
  });
});

describe("lintMarkup", () => {
  test("rejects inline color and typography styles", () => {
    expect(reasons(lintMarkup("a.tsx", '<div style={{ color: "red" }} />'))).toContain("inline-style");
    expect(reasons(lintMarkup("a.astro", '<div style="font-size: 12px"></div>'))).toContain("inline-style");
    expect(lintMarkup("a.astro", '<div style="--progress: 40%"></div>')).toEqual([]);
  });

  test("rejects className, class and style on components", () => {
    expect(reasons(lintMarkup("a.mdx", '<Notice tone="info" className="wide" message="x" />'))).toEqual(["ds-prop"]);
    expect(reasons(lintMarkup("a.astro", "<Card\n  class=\"x\"\n  href=\"/\">x</Card>"))).toEqual(["ds-prop"]);
    expect(lintMarkup("a.astro", '<div class="x"><Card href="/">x</Card></div>')).toEqual([]);
  });

  test("rejects className/style props declared by DS components", () => {
    const source = "export interface CardProps {\n  className?: string;\n}";
    expect(reasons(lintMarkup("src/ds/components/Card/Card.tsx", source))).toEqual(["ds-prop"]);
  });

  test("lets DS internals put their own classes on elements", () => {
    const source = "const shared = {\n  className: styles.card,\n};\nreturn <Component className={cn(styles.typo)} />;";
    expect(lintMarkup("src/ds/components/Typo/Typo.tsx", source)).toEqual([]);
  });

  test("lints <style> blocks in .astro files as CSS", () => {
    const findings = lintMarkup("a.astro", "<style>.x { color: #000; }</style>", { knownTokens: known });
    expect(reasons(findings)).toEqual(["raw-color"]);
  });
});

describe("repository", () => {
  test("site sources pass the style lint", () => {
    expect(lintSite().map((finding) => `${finding.path}:${finding.line} ${finding.rule}`)).toEqual([]);
  });
});
