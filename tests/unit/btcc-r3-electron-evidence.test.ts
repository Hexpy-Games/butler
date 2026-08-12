import { expect, test } from "bun:test";
import { successEvidence } from "../e2e/btcc-r3-electron/evidence.ts";

function observation() {
  return {
    stepId: "step-1",
    promptSha256: "prompt-hash",
    sessionId: "chat-1",
    turnId: "turn-1",
    providerRequestIdentities: [],
    terminalState: "delivered",
    finalText: "done",
    rendererFinalText: "done",
    rendererActivities: [],
    providerReportedModel: "gpt-5.6-luna",
    providerAgentModels: ["gpt-5.6-luna"],
    progressMessages: [],
    work: null,
    timing: {
      submittedAtMs: 1,
      acknowledgedAtMs: 2,
      firstRenderedActivityAtMs: 3,
      terminalAtMs: 4,
      elapsedMs: 3,
    },
    expectations: { passed: true, failures: [] },
    reload: { tested: true, finalMatched: true },
    restart: { tested: false, finalMatched: null },
    screenshots: [],
  };
}

function evidenceRun(providerFixtureEnabled: boolean) {
  return {
    accessMode: "full_access",
    agentOwnership: "harness",
    dataRoot: "/tmp/run/data",
    debugPort: 41001,
    electronProfile: "/tmp/run/electron",
    evidencePath: "/tmp/run/evidence.json",
    interruptedExecutorReplacementUsed: false,
    model: "openai/gpt-5.6-sol",
    providerFixtureEnabled,
    projectDisplayName: null,
    projectId: null,
    projectWorkspaceRoot: "/tmp/run/data/project-workspaces",
    reasoningEffort: "medium",
    repoRoot: "/tmp/repo",
    runId: "run-1",
    runRoot: "/tmp/run",
    serverPort: 41002,
    sessionId: "chat-1",
    sessionKind: "chat",
    sessionTitle: "Evidence",
    sourceData: "/tmp/source",
    workspaceRoot: "/tmp/run/workspace",
  } as Parameters<typeof successEvidence>[0]["run"];
}

test("deterministic fixture evidence does not claim a real provider path", () => {
  const evidence = successEvidence({
    launches: [],
    observations: [observation()],
    options: { smoke: false },
    providerRequests: [],
    run: evidenceRun(true),
  });
  expect(evidence.actualProductPath).toContain("deterministic_provider_fixture");
  expect(evidence.actualProductPath).not.toContain("real_provider");
});

test("non-fixture evidence keeps the real provider path", () => {
  const evidence = successEvidence({
    launches: [],
    observations: [observation()],
    options: { smoke: false },
    providerRequests: [],
    run: evidenceRun(false),
  });
  expect(evidence.actualProductPath).toContain("real_provider");
  expect(evidence.actualProductPath).not.toContain("deterministic_provider_fixture");
});
