import type { BenchmarkRunnerConfig } from "./runner.ts";

const SITE_VALIDATOR = `
import { readFileSync } from "node:fs";
const html = readFileSync("index.html", "utf8");
const css = readFileSync("styles.css", "utf8");
const script = readFileSync("app.js", "utf8");
if (!html.includes('name="viewport"')) throw new Error("viewport metadata is missing");
if (html.length < 400 || css.length < 300 || script.length < 20) {
  throw new Error("site implementation is incomplete");
}
console.log("site fixture build passed");
`.trimStart();

export const FORMAL_BENCHMARK_FIXTURES = Object.freeze([
  {
    path: "fixtures/inputs/2026-01.csv",
    text: [
      "month,category,revenue_krw",
      "2026-01,Alpha,120000",
      "2026-01,Beta,80000",
      "2026-01,Gamma,50000",
      "",
    ].join("\n"),
  },
  {
    path: "fixtures/inputs/2026-02.csv",
    text: [
      "month,category,revenue_krw",
      "2026-02,Alpha,130000",
      "2026-02,Beta,65000",
      "2026-02,Gamma,80000",
      "",
    ].join("\n"),
  },
  {
    path: "fixtures/inputs/2026-03.csv",
    text: [
      "month,category,revenue_krw",
      "2026-03,Alpha,155000",
      "2026-03,Beta,75000",
      "2026-03,Gamma,70000",
      "",
    ].join("\n"),
  },
  {
    path: "package.json",
    text: `${JSON.stringify({
      name: "butler-benchmark-site",
      private: true,
      type: "module",
      scripts: { build: "node scripts/verify-site.mjs" },
    }, null, 2)}\n`,
  },
  {
    path: "scripts/verify-site.mjs",
    text: SITE_VALIDATOR,
  },
  {
    path: "index.html",
    text: [
      "<!doctype html>",
      '<html lang="ko">',
      "<head>",
      '  <meta charset="UTF-8" />',
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
      "  <title>Product</title>",
      '  <link rel="stylesheet" href="./styles.css" />',
      "</head>",
      "<body>",
      '  <main id="app"><h1>Replace this starter page</h1></main>',
      '  <script type="module" src="./app.js"></script>',
      "</body>",
      "</html>",
      "",
    ].join("\n"),
  },
  {
    path: "styles.css",
    text: [
      ":root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }",
      "* { box-sizing: border-box; }",
      "body {",
      "  min-width: 320px;",
      "  min-height: 100vh;",
      "  margin: 0;",
      "  background: #0b0d12;",
      "  color: #f6f7fb;",
      "}",
      "#app { min-height: 100vh; }",
      "",
    ].join("\n"),
  },
  {
    path: "app.js",
    text: 'document.documentElement.dataset.appReady = "true";\n',
  },
] as const);

export const FORMAL_BENCHMARK_ARTIFACT_PATHS = Object.freeze({
  work_market_research: ["artifacts/market.md"],
  work_sausage_research: ["artifacts/sausage.md"],
  work_fixture_analysis: ["artifacts/analysis.md"],
  project_butler_landing: ["index.html", "styles.css", "app.js"],
  project_sandy_landing: ["index.html", "styles.css", "app.js"],
  project_product_dashboard: ["index.html", "styles.css", "app.js"],
});

export function formalBenchmarkPlaceholders(observationDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(observationDate)) {
    throw new Error("Formal benchmark observation date must be YYYY-MM-DD");
  }
  return {
    WEATHER_DATE: observationDate,
    NEWS_DATE: observationDate,
    EXISTING_FOLDER_PATH: "fixtures/inputs",
    MARKET_DATE: observationDate,
    WORK_REPORT_PATH: "artifacts/market.md",
    SAUSAGE_REPORT_PATH: "artifacts/sausage.md",
    WORK_INPUT_FOLDER: "fixtures/inputs",
    WORK_ANALYSIS_REPORT_PATH: "artifacts/analysis.md",
  };
}

export function formalBenchmarkRunnerConfig(input: {
  runRoot: string;
  sourceData?: string;
}): BenchmarkRunnerConfig {
  return {
    runRoot: input.runRoot,
    ...(input.sourceData ? { sourceData: input.sourceData } : {}),
    fixtures: FORMAL_BENCHMARK_FIXTURES.map((fixture) => ({ ...fixture })),
    artifactPathsByPrompt: Object.fromEntries(
      Object.entries(FORMAL_BENCHMARK_ARTIFACT_PATHS).map(([key, paths]) => [
        key,
        [...paths],
      ]),
    ),
  };
}
