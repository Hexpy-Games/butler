import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compileTurnContract, TURN_CONTRACT_DECISION_SCHEMA } from "../../packages/butler-agent/src/agent/turn/turn-contract.ts";
import { recordTurnContractMetric } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/turn-contract-metrics.ts";
import { operationalMetricsPath } from "../../packages/butler-agent/src/operations/metrics/operational-metrics.ts";

const tempDirs: string[] = [];
afterEach(() => tempDirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

test("typed contract metrics contain safe enums and counts without durable ids", () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-contract-metrics-"));
  tempDirs.push(butlerData);
  const contract = compileTurnContract({
    decision: {
      schema_version: TURN_CONTRACT_DECISION_SCHEMA,
      decision_id: "private-decision-id",
      action: "start_work",
      target_project_id: "private-project-id",
      deliverables: ["code_change", "validation"],
      public_summary: "Private public summary is still not metric data.",
    },
  });
  recordTurnContractMetric({
    butlerData,
    name: "compiled",
    status: "ok",
    contract,
  });

  const event = JSON.parse(readFileSync(operationalMetricsPath(butlerData), "utf8").trim());
  expect(event).toMatchObject({
    name: "typed_turn_contract_compiled",
    rawTextStored: false,
    dimensions: {
      action: "start_work",
      trackingMode: "local",
      deliverableCount: 2,
      obligationCount: 2,
      evidenceReceiptCount: 0,
      continuationCount: 0,
    },
  });
  const serialized = JSON.stringify(event);
  expect(serialized).not.toContain(contract.contract_id);
  expect(serialized).not.toContain("private-decision-id");
  expect(serialized).not.toContain("private-project-id");
  expect(serialized).not.toContain("Private public summary");
});
