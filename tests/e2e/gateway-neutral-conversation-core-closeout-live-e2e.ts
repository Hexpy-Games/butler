import { homedir } from "node:os";
import { join } from "node:path";
import {
  closeoutConfig,
  ledgerChecks,
  runCloseoutCheck,
  type CloseoutCheck,
} from "../support/gncc-closeout-runner.ts";

const bun = process.env.BUTLER_BUN || process.execPath;
const { model, reasoningEffort } = closeoutConfig({
  model: process.env.BUTLER_GNCC_CLOSEOUT_E2E_MODEL,
  reasoningEffort: process.env.BUTLER_GNCC_CLOSEOUT_E2E_REASONING,
});
const ledgerProject = process.env.BUTLER_GNCC_CLOSEOUT_LEDGER_PROJECT ||
  join(homedir(), ".butler", "project-ledger", "projects", "butler");
const projectLedgerBin = join(process.cwd(), "packages", "project-ledger", "bin", "project-ledger");

const checks: CloseoutCheck[] = [
  {
    name: "deterministic-spec-family-gates",
    cmd: [
      bun,
      "test",
      "tests/unit/agent-conversation-store.test.ts",
      "tests/unit/conversation-admission.test.ts",
      "tests/unit/app-conversation-projection.test.ts",
      "tests/unit/conversation-context.test.ts",
      "tests/unit/context-compaction.test.ts",
      "tests/unit/gateway-neutral-closeout-fixture.test.ts",
      "tests/unit/gateway-neutral-closeout-runner.test.ts",
      "tests/unit/historical-recovery.test.ts",
      "tests/unit/historical-recovery-runtime.test.ts",
      "tests/unit/session-sync.test.ts",
      "tests/unit/transport-agnostic-conversation.test.ts",
      "tests/unit/native-conversation-harness.test.ts",
      "tests/unit/gateway-neutral-conversation-core-baseline.test.ts",
      "--timeout",
      "60000",
    ],
  },
  {
    name: "live-context-compaction",
    cmd: [bun, "run", "tests/e2e/gateway-neutral-conversation-context-live-e2e.ts"],
    env: {
      BUTLER_GNCC_CONTEXT_E2E_MODEL: model,
      BUTLER_GNCC_CONTEXT_E2E_REASONING: reasoningEffort,
    },
    parseJson: true,
    validateJson: "live-e2e",
    expectedService: "gateway-neutral-conversation-context-live-e2e",
    expectedModel: model,
    expectedReasoningEffort: reasoningEffort,
    minLiveModelCalls: 2,
  },
  {
    name: "live-cognition-sources",
    cmd: [bun, "run", "tests/e2e/gateway-neutral-cognition-sources-live-e2e.ts"],
    env: {
      BUTLER_GNCC_COGNITION_E2E_MODEL: model,
      BUTLER_GNCC_COGNITION_E2E_REASONING: reasoningEffort,
    },
    parseJson: true,
    validateJson: "live-e2e",
    expectedService: "gateway-neutral-cognition-sources-live-e2e",
    expectedModel: model,
    expectedReasoningEffort: reasoningEffort,
  },
  {
    name: "live-historical-recovery",
    cmd: [bun, "run", "tests/e2e/gateway-neutral-historical-recovery-live-e2e.ts"],
    env: {
      BUTLER_GNCC_RECOVERY_E2E_MODEL: model,
      BUTLER_GNCC_RECOVERY_E2E_REASONING: reasoningEffort,
    },
    parseJson: true,
    validateJson: "live-e2e",
    expectedService: "gateway-neutral-historical-recovery-live-e2e",
    expectedModel: model,
    expectedReasoningEffort: reasoningEffort,
  },
  ...ledgerChecks({ ledgerProject, projectLedgerBin }),
];

const results = checks.map((check) => runCloseoutCheck(check));
const liveModelCalls = results.reduce((sum, result) => sum + result.liveModelCalls, 0);

assert(liveModelCalls >= 4, `expected at least 4 live model calls across closeout, got ${liveModelCalls}`);
assert(results.every((result) => result.ok), `closeout check failed: ${JSON.stringify(results)}`);

console.log(JSON.stringify({
  ok: true,
  service: "gateway-neutral-conversation-core-closeout-live-e2e",
  model,
  reasoningEffort,
  liveModelCalls,
  checks: results,
}, null, 2));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
