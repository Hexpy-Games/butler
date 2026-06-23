import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

interface InventoryEntry {
  path: string;
  lineCount: number;
  importCount: number;
  keyDependencies: string[];
  owner: string;
  target: string;
  oversizedChangedArea?: boolean;
}

const inventory: InventoryEntry[] = [
  entry("packages/butler-agent/src/gateways/app/store.ts", 10328, 38, ["./protocol.ts", "./failure-ux-contract.ts", "../../agent/turn/runtime-cancellation.ts"], "app persistence and projection", "legacy exception; extract runtime-to-app delivery projection on future app-store edits", true),
  entry("packages/butler-agent/src/integrations/providers/provider.ts", 4220, 19, ["./provider-errors.ts", "../../agent/turn/agent-loop.ts"], "model provider runtime", "legacy exception; keep provider diagnostics in provider-errors and operational-errors", true),
  entry("packages/butler-agent/src/agent/turn/native-tool-loop.ts", 3241, 37, ["./tool-loop-guards.ts", "./bridge-tool-executor.ts", "./tool-surface-prompt-controller.ts", "./native-tool-instructions.ts", "./completion-review-orchestrator.ts"], "native runtime loop", "keep direct-turn orchestration thin by delegating loop guards, tool surface state, bridge execution, and static instruction assembly", true),
  entry("packages/butler-app/client/ui/src/app/utils.ts", 2424, 3, ["./types.ts"], "app client projection utilities", "legacy exception; keep delivery metadata equality helpers isolated on future edits", true),
  entry("packages/butler-agent/src/gateways/app/protocol.ts", 2175, 0, [], "app wire protocol", "legacy exception; add typed protocol fields without moving generated-like surface", true),
  entry("packages/butler-app/client/ui/src/app/store.ts", 1512, 12, ["./types.ts", "./utils.ts"], "app client state store", "legacy exception; move delivery metadata merge helpers out on future edits", true),
  entry("packages/butler-agent/src/agent/tool-support/planned-worker-runtime.ts", 1276, 13, ["./planned-review-evidence.ts", "../work/work-orchestration.ts"], "planned worker runtime", "legacy exception; evidence review support is already delegated", true),
  entry("packages/butler-app/client/ui/src/app/types.ts", 1153, 1, ["react"], "app client wire types", "legacy exception; keep delivery state additions typed and backward-compatible", true),
  entry("packages/butler-agent/src/interfaces/gateway/session-actor.ts", 841, 7, ["../../integrations/providers/provider-errors.ts"], "gateway session actor", "legacy exception; provider failure classification stays delegated", true),
  entry("packages/butler-agent/src/interfaces/gateway/native-butler-bootstrap.ts", 841, 29, ["./queued-inbound.ts", "../../agent/turn/native-tool-loop.ts"], "native gateway bootstrap", "legacy exception; queued inbound and runtime loop own new behavior", true),
  entry("packages/butler-agent/src/agent/tools/run-command/run_command/executor.ts", 691, 6, ["./evidence.ts"], "run_command executor", "legacy exception; command evidence is delegated to evidence.ts", true),
  entry("packages/butler-agent/src/interfaces/gateway/queued-inbound.ts", 580, 7, ["../../agent/turn/recoverable-delivery.ts", "../../integrations/providers/provider-errors.ts"], "queued inbound gateway", "split limited-delivery and failure-action projection helpers", true),
  entry("packages/butler-agent/src/agent/events/turn-events.ts", 477, 2, ["node:buffer", "node:crypto"], "turn event persistence", "legacy exception; keep privacy-safe transcript helpers delegated", true),
  entry("packages/butler-agent/src/agent/output/final-output-contract.ts", 399, 4, ["./completion-obligation-evidence.ts"], "final answer contract", "split evidence review semantics from final-answer leak repair", true),
  entry("packages/butler-agent/src/agent/tools/profiles.ts", 297, 2, ["../../integrations/providers/provider.ts", "./butler-tools.ts"], "tool profile policy", "keep under 300 lines and delegate surface selection to focused helpers"),
  entry("packages/butler-agent/src/agent/tools/tool-surface-controller.ts", 253, 2, ["./tool-surface-types.ts", "./tool-surface-validation.ts"], "tool surface state", "keep under 300 lines and split bridge orchestration into tool-bridge modules"),
  entry("packages/butler-agent/src/agent/turn/bridge-tool-executor.ts", 278, 9, ["../tools/tool-bridge/audit.ts", "../output/tool-progress.ts", "../output/evidence-transcript-result.ts"], "bridge tool execution", "keep bridge resolution, progress, audit, and transcript orchestration outside native runtime loop"),
  entry("packages/butler-agent/src/agent/turn/tool-loop-guards.ts", 125, 0, [], "native tool loop policy guards", "keep repeated-family and round-limit policy outside the native runtime loop"),
  entry("packages/butler-agent/src/agent/turn/tool-surface-prompt-controller.ts", 125, 2, ["../../integrations/providers/provider.ts", "../tools/tool-surface-selection.ts"], "tool surface prompt state", "keep selected provider-tool state and same-turn promotion outside native runtime loop"),
  entry("packages/butler-agent/src/agent/turn/native-tool-instructions.ts", 129, 1, ["../../test-support/harness/contracts.ts"], "native tool instructions", "keep static Butler tool and role policy prompt assembly outside native runtime loop"),
  entry("packages/butler-agent/src/integrations/providers/provider-errors.ts", 282, 1, ["./operational-errors.ts"], "provider diagnostics", "keep under 300 lines with operational-errors owning service/storage/policy taxonomy"),
  entry("packages/butler-agent/src/agent/turn/runtime-delivery-state.ts", 287, 2, ["./runtime-cancellation.ts", "./operational-failure.ts"], "runtime delivery taxonomy", "keep under 300 lines with focused operational/cancellation helpers"),
  entry("packages/butler-agent/src/agent/output/evidence-capability-ledger-state.ts", 237, 3, ["./evidence-capability-parser.ts", "./evidence-capability-types.ts"], "evidence capability ledger", "keep evidence proof semantics under 300 lines outside final-output formatting"),
];

const oversizedChangedImplementationPaths = inventory
  .filter((item) => item.oversizedChangedArea)
  .map((item) => item.path);

test("tool runtime refactor inventory records exact line counts and dependencies", () => {
  for (const item of inventory) {
    const text = readFileSync(join(repoRoot, item.path), "utf8");
    const imports = importSources(text);
    expect(text.split(/\r?\n/u).length, item.path).toBe(item.lineCount);
    expect(imports.length, item.path).toBe(item.importCount);
    expect(item.owner, item.path).not.toHaveLength(0);
    expect(item.target, item.path).not.toHaveLength(0);
    for (const source of item.keyDependencies) {
      expect(imports, item.path).toContain(source);
    }
  }
});

test("tool runtime refactor inventory maps every oversized changed implementation area", () => {
  expect(oversizedChangedImplementationPaths).toEqual([
    "packages/butler-agent/src/gateways/app/store.ts",
    "packages/butler-agent/src/integrations/providers/provider.ts",
    "packages/butler-agent/src/agent/turn/native-tool-loop.ts",
    "packages/butler-app/client/ui/src/app/utils.ts",
    "packages/butler-agent/src/gateways/app/protocol.ts",
    "packages/butler-app/client/ui/src/app/store.ts",
    "packages/butler-agent/src/agent/tool-support/planned-worker-runtime.ts",
    "packages/butler-app/client/ui/src/app/types.ts",
    "packages/butler-agent/src/interfaces/gateway/session-actor.ts",
    "packages/butler-agent/src/interfaces/gateway/native-butler-bootstrap.ts",
    "packages/butler-agent/src/agent/tools/run-command/run_command/executor.ts",
    "packages/butler-agent/src/interfaces/gateway/queued-inbound.ts",
    "packages/butler-agent/src/agent/events/turn-events.ts",
    "packages/butler-agent/src/agent/output/final-output-contract.ts",
  ]);
});

function entry(
  path: string,
  lineCount: number,
  importCount: number,
  keyDependencies: string[],
  owner: string,
  target: string,
  oversizedChangedArea = false,
): InventoryEntry {
  return { path, lineCount, importCount, keyDependencies, owner, target, oversizedChangedArea };
}

function importSources(text: string): string[] {
  return [...text.matchAll(/^import(?:\s+type)?[\s\S]*?from\s+["']([^"']+)["'];/gm)]
    .map((match) => match[1]);
}
