import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { BenchmarkArmPlan, BenchmarkFixture } from "./contracts.ts";
import { inventoryOutputFiles } from "./repository-evidence.ts";

export function landingClaimMatches(
  arm: BenchmarkArmPlan,
  fixture: BenchmarkFixture,
  repositoryEvidenceRoot?: string,
): number {
  const text = (fixture.expectedFiles ?? []).map((path) => {
    try { return readFileSync(resolve(arm.outputRoot, path), "utf8"); } catch { return ""; }
  }).join("\n").toLowerCase();
  const readme = readText(resolve(arm.outputRoot, "README.md")).toLowerCase();
  const predicates = [
    /local[- ]first[^.]{0,120}assistant/u,
    /agent\s+runtime[^.]{0,120}(?:desktop|app)/u,
    /(?:project|work)[- ]tracking[^.]{0,120}(?:durable|state)[\s\S]{0,240}(?:README|package\.json|packages\/)/u,
  ];
  if (repositoryEvidenceRoot) {
    const evidence = readEvidenceText(repositoryEvidenceRoot);
    const citation = ["README.md", "package.json", "packages/butler-app/client/electron/package.json", "packages/project-ledger/package.json"]
      .some((path) => readme.includes(path.toLowerCase()));
    if (!citation || !evidence) return 0;
    const sourcePredicates = [
      /local[- ]first[^.]{0,120}(?:assistant|agent\s+runtime)/u,
      /agent\s+runtime[\s\S]{0,200}(?:desktop|app)/u,
      /(?:durable|state)[\s\S]{0,200}(?:project|work)/u,
    ];
    return predicates.filter((predicate, index) => predicate.test(text) && sourcePredicates[index]!.test(evidence)).length;
  }
  return predicates.filter((predicate) => predicate.test(text)).length;
}

function readText(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function readEvidenceText(root: string): string {
  try {
    return inventoryOutputFiles(root).map((path) => readText(resolve(root, path))).join("\n").toLowerCase();
  } catch {
    return "";
  }
}
