import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import { KO_DOCS_ROOT, SITE_ROOT, lintKoDocs, walk } from "./lint-prose";
import { EN_DOCS_ROOT, EN_GUIDE, lintEnDocs, lintEnglishProse, loadEnglishPhrases } from "./lint-prose-en";

const lint = (source: string) => lintEnglishProse("page.mdx", source);
const rules = (source: string) => lint(source).map((finding) => finding.rule);
const ids = (source: string) => lint(source).map((finding) => finding.id);

describe("banned-phrase", () => {
  test("each data-file example triggers its own phrase id and no other", () => {
    for (const phrase of loadEnglishPhrases()) {
      expect({ id: phrase.id, found: ids(phrase.example) }).toEqual({ id: phrase.id, found: [phrase.id] });
    }
  });

  test("matches whole words in any case, in body text, headings and list items", () => {
    expect(ids("## A Robust setup\n\n- LEVERAGE the sidebar.\n")).toEqual(["robust", "leverage"]);
    expect(lint("The every-day view shows the overall status. Butler runs in orderly steps.\n")).toEqual([]);
  });

  test("reports path:line and names the phrase id", () => {
    const [finding] = lintEnglishProse("en/page.mdx", "Open Settings.\n\nOpen it in order to add a model.\n");
    expect(finding).toMatchObject({ path: "en/page.mdx", line: 3, rule: "banned-phrase", id: "in-order-to" });
    expect(finding.message).toContain("en/page.mdx:3 [in-order-to]");
  });

  test("ignores frontmatter, code, JSX props, link targets, bold UI labels and quoted UI strings", () => {
    const source = [
      "---",
      'title: "A robust page"',
      "---",
      "",
      "```bash",
      "butler robust --seamlessly",
      "```",
      "",
      "Run `butler leverage`. Choose **Simply connect**. The message \"Very powerful\" appears.",
      "",
      '<Notice tone="info" title="A powerful notice">',
      "  See [the release](https://example.com/seamless/robust).",
      "</Notice>",
      "",
    ].join("\n");
    expect(lint(source)).toEqual([]);
  });
});

describe("product-term", () => {
  test("flags automation and Steward, in bold labels and quotes too", () => {
    expect(lint("Open the automations list.\n").map((finding) => [finding.rule, finding.id])).toEqual([["product-term", "automation"]]);
    expect(ids("Choose **Automation**. \"Steward\" appears.\n")).toEqual(["automation", "steward"]);
    expect(lint("Schedules run automatically. A schedule sends a prompt.\n")).toEqual([]);
  });

  test("cannot be disabled", () => {
    const source = "{/* prose-lint-disable-next-line product-term -- quoted */}\nOpen the automations list.\n";
    expect(rules(source)).toEqual(["disable-syntax", "product-term"]);
  });
});

describe("emoji", () => {
  test("flags emoji, but not arrows, keys or symbols", () => {
    expect(rules("🚀 Open Settings.\n")).toEqual(["emoji"]);
    expect(lint('Press <Kbd keys={["⌘", "K"]} />. Open **Settings → General**. Open the menu (⋯).\n')).toEqual([]);
  });
});

describe("escape hatch", () => {
  test("a phrase id can be disabled with a reason; an unused directive is a finding", () => {
    expect(lint("{/* prose-lint-disable-next-line banned-phrase/various -- quotes the CLI help */}\nThe help text says various flags.\n")).toEqual([]);
    expect(rules("{/* prose-lint-disable-next-line emoji -- none here */}\nOpen Settings.\n")).toEqual(["unused-disable"]);
  });
});

describe("scope", () => {
  const files = (root: string) => walk(root).map((file) => relative(SITE_ROOT, file).split(sep).join("/"));

  test("the Korean lint reads ko pages only, the English check en pages only", () => {
    expect(files(KO_DOCS_ROOT).every((file) => file.startsWith("src/content/docs/ko/"))).toBe(true);
    expect(files(EN_DOCS_ROOT).every((file) => file.startsWith("src/content/docs/en/"))).toBe(true);
    expect(lintKoDocs().filter((finding) => !finding.path.startsWith("src/content/docs/ko/"))).toEqual([]);
    expect(lintEnDocs().filter((finding) => !finding.path.startsWith("src/content/docs/en/"))).toEqual([]);
  });

  test("Korean rules do not apply to English prose", () => {
    expect(lint("Open Settings. Choose a model.\n\n- macOS 12 or later\n- Open the app.\n")).toEqual([]);
  });
});

describe("guide", () => {
  test("lists exactly the phrase ids in the English lint data file", () => {
    const guide = readFileSync(EN_GUIDE, "utf8");
    const listed = [...guide.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gmu)].map((match) => match[1]);
    expect(listed.sort()).toEqual(loadEnglishPhrases().map((phrase) => phrase.id).sort());
  });
});
