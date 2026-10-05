import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

function trackedFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "buffer",
  });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString("utf8")}`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

async function scanTrackedText(inspect: (file: string, text: string) => string[]): Promise<string[]> {
  const files = trackedFiles();
  const results: string[][] = new Array(files.length);
  let cursor = 0;
  // Bound open files while overlapping filesystem latency. Every tracked text
  // is still read and inspected by each audit; no corpus or result cache.
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (cursor < files.length) {
      const index = cursor++;
      const file = files[index]!;
      let buffer: Buffer;
      try { buffer = await readFile(join(root, file)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { results[index] = []; continue; }
        throw error;
      }
      results[index] = buffer.includes(0) ? [] : inspect(file, buffer.toString("utf8"));
    }
  }));
  return results.flat();
}

// test-category: security
test("tracked files do not contain operator-specific hardcoded fixtures", async () => {
  const operatorSlug = ["yeon", "woo"].join("");
  const koreanOperatorName = ["연", "우"].join("");
  const koreanSystemName = ["조", "연", "우"].join("");
  const forbiddenValues = [
    { label: "operator Unix home path", value: `/Users/${operatorSlug}` },
    { label: "operator romanized name", value: ["Yeon", "woo"].join("") },
    { label: "operator Korean name", value: koreanOperatorName },
    { label: "operator public handle", value: `@${operatorSlug}_jo` },
    { label: "operator public numeric id", value: ["861", "455", "9634"].join("") },
    { label: "operator private LAN address", value: ["192", "168", "1", "34"].join(".") },
    { label: "old local-model LAN placeholder", value: ["192", "168", "1", "8"].join(".") },
    {
      label: "operator hostname",
      value: ["joyeon", "uui", ["Mac", "Book", "Pro"].join(""), "2"].join("-"),
    },
    { label: "operator computer name", value: koreanSystemName },
    { label: "private dogfood cue", value: ["밈", "미"].join("") },
    { label: "private dogfood entity", value: ["반", "디"].join("") },
    { label: "private dogfood entity", value: ["은", "랑"].join("") },
    { label: "private dogfood entity", value: ["에바", "네시아"].join("") },
    { label: "private dogfood place", value: ["함경", "옥"].join("") },
  ];

  const findings = await scanTrackedText((file, text) => forbiddenValues
    .filter((forbidden) => text.includes(forbidden.value))
    .map((forbidden) => `${file}: ${forbidden.label}`));

  expect(findings).toEqual([]);
});

const privateLanAddress =
  /\b(?:10\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])|172\.(?:1[6-9]|2[0-9]|3[0-1])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])|192\.168\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9]))\b/gu;

// Tests that verify LAN classification need real private-range literals
// (documentation ranges such as 192.0.2.x are not private). Such a line may
// opt out with this marker; it is honored only in test files, only on that line.
const ALLOW_PRIVATE_IP_MARKER = "privacy-hygiene: allow-private-ip";
const TEST_FILE_PATH = /(?:^|\/)(?:tests?|__tests__)(?:\/|\.rs$)|[._-]test\.[cm]?[jt]sx?$|_test\.rs$/u;

function findPrivateLanAddresses(file: string, text: string): string[] {
  if (!text.includes("10.") && !text.includes("172.") && !text.includes("192.168.")) return [];
  const markersHonored = TEST_FILE_PATH.test(file);
  const findings: string[] = [];
  for (const line of text.split("\n")) {
    if (markersHonored && line.includes(ALLOW_PRIVATE_IP_MARKER)) continue;
    for (const match of line.matchAll(privateLanAddress)) {
      findings.push(`${file}: ${match[0]}`);
    }
  }
  return findings;
}

// test-category: pure-logic
test("allow-private-ip marker is honored only on marked lines of test files", () => {
  const ip = ["192", "168", "0", "20"].join(".");
  const marked = `("${ip}", true), // ${ALLOW_PRIVATE_IP_MARKER} (LAN test)`;
  expect(findPrivateLanAddresses("crate/src/policy/tests.rs", marked)).toEqual([]);
  expect(findPrivateLanAddresses("tests/unit/lan.test.ts", marked)).toEqual([]);
  expect(findPrivateLanAddresses("crate/src/policy/mod.rs", marked)).toEqual([
    `crate/src/policy/mod.rs: ${ip}`,
  ]);
  expect(
    findPrivateLanAddresses("crate/src/policy/tests.rs", `${marked}\nlet x = "${ip}";`),
  ).toEqual([`crate/src/policy/tests.rs: ${ip}`]);
});

// test-category: security
test("tracked files do not contain private LAN IP address literals", async () => {
  const findings = await scanTrackedText(findPrivateLanAddresses);
  expect(findings).toEqual([]);
});
