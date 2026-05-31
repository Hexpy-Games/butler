import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

function readTrackedText(path: string): string | null {
  if (!existsSync(join(root, path))) return null;
  const buffer = readFileSync(join(root, path));
  if (buffer.includes(0)) return null;
  return buffer.toString("utf8");
}

test("tracked files do not contain operator-specific hardcoded fixtures", () => {
  const operatorSlug = ["yeon", "woo"].join("");
  const koreanOperatorName = ["연", "우"].join("");
  const koreanSystemName = ["조", "연", "우"].join("");
  const forbiddenValues = [
    { label: "operator Unix home path", value: `/Users/${operatorSlug}` },
    { label: "operator romanized name", value: ["Yeon", "woo"].join("") },
    { label: "operator Korean name", value: koreanOperatorName },
    { label: "operator Telegram handle", value: `@${operatorSlug}_jo` },
    { label: "operator Telegram numeric id", value: ["861", "455", "9634"].join("") },
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

  const findings: string[] = [];
  for (const file of trackedFiles()) {
    const text = readTrackedText(file);
    if (text === null) continue;
    for (const forbidden of forbiddenValues) {
      if (text.includes(forbidden.value)) {
        findings.push(`${file}: ${forbidden.label}`);
      }
    }
  }

  expect(findings).toEqual([]);
});

test("tracked files do not contain private LAN IP address literals", () => {
  const privateLanAddress =
    /\b(?:10\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])|172\.(?:1[6-9]|2[0-9]|3[0-1])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])|192\.168\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9]))\b/gu;

  const findings: string[] = [];
  for (const file of trackedFiles()) {
    const text = readTrackedText(file);
    if (text === null) continue;
    for (const match of text.matchAll(privateLanAddress)) {
      findings.push(`${file}: ${match[0]}`);
    }
  }

  expect(findings).toEqual([]);
});
