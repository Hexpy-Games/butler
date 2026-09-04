import { expect, test } from "bun:test";
import type {
  AuthorityOutcomeReceipt,
  AuthorityStoredExecution,
  PrincipalAuthority,
} from "../../packages/butler-agent/src/agent/btcc/authority/contracts.ts";
import type { GuidedActivityProjection } from
  "../../packages/butler-agent/src/agent/btcc/projection/index.ts";
import { createGuidedAskFirstProgress, createGuidedAuthorityProjection } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/guided-operational-progress.ts";
import {
  deriveUncertainAuthorityOutcomeReceipt,
  parseAuthorityOutcomeReceipt,
  type GuidedEffectUncertainEvidenceInput,
} from
  "../../packages/butler-agent/src/agent/btcc/authority/outcome-receipt.ts";

type UncertainAuthorityOutcomeReceipt = Extract<
  AuthorityOutcomeReceipt,
  { outcome: "uncertain" }
>;

const OWNER_SESSION_ID = "owner-session-outcome-contract";
const TURN_ID = "turn-outcome-contract";
const REQUEST_REF = "auth-request-outcome-contract";

function inertActivity(): GuidedActivityProjection {
  return {
    observeToolBatch: () => {},
    observeTool: () =>
      Promise.resolve({ activityId: "inert-activity", deferredUntilAccepted: false }),
    markManaged: () => Promise.resolve(),
    publishAccepted: () => Promise.resolve(),
  };
}

function uncertainStoredExecution(
  receipt?: AuthorityOutcomeReceipt,
): AuthorityStoredExecution {
  return {
    requestRef: REQUEST_REF,
    sourceSessionId: "source-session-outcome-contract",
    sourceTurnId: TURN_ID,
    sourceWorkId: "work-outcome-contract",
    workspacePath: "/workspace/outcome-contract",
    planRevisionId: "plan-outcome-contract",
    actionKey: "run_command",
    authorityGeneration: 1,
    capability: "command",
    normalizedTarget: "command:inert",
    normalizedInput: {
      command: "echo inert",
      cwd: "/workspace/outcome-contract",
      state_effect: "mutation",
    },
    decision: "allowed",
    outcome: "uncertain",
    ...(receipt ? { outcomeReceipt: receipt } : {}),
  };
}

function fakeAuthority(stored: AuthorityStoredExecution): PrincipalAuthority {
  return {
    execution: () => stored,
  } as unknown as PrincipalAuthority;
}

function projectionFor(receipt?: AuthorityOutcomeReceipt) {
  return createGuidedAuthorityProjection({
    accessMode: "ask_first",
    activity: inertActivity(),
    authority: fakeAuthority(uncertainStoredExecution(receipt)),
    ownerSessionId: OWNER_SESSION_ID,
    turnId: TURN_ID,
    requestRef: REQUEST_REF,
  });
}

test("stored uncertain outcome projects terminally with its bounded evidence ref", () => {
  const guided = projectionFor({
    schema: "butler.authority-outcome-receipt.v1",
    outcome: "uncertain",
    evidenceRef: "authority-evidence-abc12345",
    journalEffectId: "journal-effect-private-7f3a",
    dispatchAttempt: 2,
    errorCode: "effect_reconciliation_required",
  });

  expect(guided.project("ignored model text")).toBe(
    "확인 필요 · authority-evidence-abc12345",
  );
  expect(guided.project("ignored model text")).toBe(
    "확인 필요 · authority-evidence-abc12345",
  );
});

test("derived uncertain receipts survive the strict stored-receipt reader round-trip", () => {
  const evidence: GuidedEffectUncertainEvidenceInput = {
    effectId: `guided-effect-${"3f9a1c7e5b2d4806".repeat(4)}`,
    identitySha256: "a1b2c3d4e5f60718".repeat(4),
    dispatchAttempt: 2,
    errorCode: "effect_reconciliation_required",
  };

  const derived = deriveUncertainAuthorityOutcomeReceipt(evidence);
  expect(derived).not.toBeNull();

  const parsed = parseAuthorityOutcomeReceipt(JSON.stringify(derived));
  expect(parsed).toEqual(derived);
});

test("the uncertain projection never exposes receipt internals", () => {
  const receipt: UncertainAuthorityOutcomeReceipt = {
    schema: "butler.authority-outcome-receipt.v1",
    outcome: "uncertain",
    evidenceRef: "authority-evidence-abc12345",
    journalEffectId: "journal-effect-private-7f3a",
    dispatchAttempt: 271828,
    errorCode: "effect_reconciliation_required",
  };
  const guided = projectionFor(receipt);

  const projected = guided.project("ignored model text");
  expect(projected).not.toContain(receipt.journalEffectId);
  expect(projected).not.toContain(String(receipt.dispatchAttempt));
  expect(projected).not.toContain(receipt.errorCode);
});

test("missing or unsafe evidence refs project only the bare uncertain text", () => {
  const privatePathEvidence = "authority-evidence-../../private/journal;x=1";
  const oversizedEvidence = `authority-evidence-${"a".repeat(65)}`;
  for (const receipt of [
    undefined,
    {
      schema: "butler.authority-outcome-receipt.v1",
      outcome: "uncertain",
      evidenceRef: privatePathEvidence,
      journalEffectId: "journal-effect-private-7f3a",
      dispatchAttempt: 9,
      errorCode: "effect_reconciliation_required",
    },
    {
      schema: "butler.authority-outcome-receipt.v1",
      outcome: "uncertain",
      evidenceRef: oversizedEvidence,
      journalEffectId: "journal-effect-private-7f3a",
      dispatchAttempt: 9,
      errorCode: "effect_reconciliation_required",
    },
  ] satisfies Array<AuthorityOutcomeReceipt | undefined>) {
    const guided = projectionFor(receipt);

    const projected = guided.project("ignored model text");
    expect(projected).toBe("확인 필요");
    if (receipt) expect(projected).not.toContain(receipt.evidenceRef);
  }
});

test("ask-first preserves safe Work progress while hiding operation details", async () => {
  const forwarded: string[] = [];
  const progress = createGuidedAskFirstProgress({
    stateChanged: () => { forwarded.push("state"); },
    workProgressChanged: () => { forwarded.push("work"); },
    phaseActivityChanged: () => { forwarded.push("phase"); },
    operationChanged: () => { forwarded.push("operation"); },
  });

  await progress?.stateChanged({
    turnId: TURN_ID,
    turnRevision: 1,
    semanticState: "running",
  });
  await progress?.workProgressChanged?.({
    turnId: TURN_ID,
    turnRevision: 1,
    programId: "work",
    tasks: [],
  });
  await progress?.phaseActivityChanged?.({
    turnId: TURN_ID,
    semanticState: "running",
    activityId: "phase",
    title: "Planning",
    summary: "Planning",
    nextStep: "Execute",
  });
  await progress?.operationChanged?.({
    turnId: TURN_ID,
    semanticState: "running",
    activityId: "operation",
    requestId: "private-request",
    publicTitle: "Run command",
    capabilityRef: "command",
    status: "started",
  });

  expect(forwarded).toEqual(["state", "work", "phase"]);
});

test("ask-first does not claim approval while ordinary tools are still running", () => {
  const observed: Array<{
    text: string;
    toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  }> = [];
  const activity: GuidedActivityProjection = {
    observeToolBatch: (batch) => { observed.push(batch); },
    observeTool: () =>
      Promise.resolve({ activityId: "ordinary-activity", deferredUntilAccepted: false }),
    markManaged: () => Promise.resolve(),
    publishAccepted: () => Promise.resolve(),
  };
  const guided = createGuidedAuthorityProjection({
    accessMode: "ask_first",
    activity,
    ownerSessionId: OWNER_SESSION_ID,
    turnId: TURN_ID,
  });

  guided.publicActivity.observeToolBatch({
    text: "현재 구현을 확인하고 있습니다.",
    toolCalls: [{ name: "read_file", args: { path: "/private/workspace/file.ts" } }],
  });
  guided.loopCallbacks.onAssistantTextBeforeTools?.({
    text: "관련 파일을 계속 살펴보고 있습니다.",
    toolCalls: [{
      id: "read-call",
      name: "read_file",
      arguments: { path: "/private/workspace/other.ts" },
      rawArguments: "{}",
    }],
    iteration: 1,
  });

  expect(observed).toEqual([
    {
      text: "현재 구현을 확인하고 있습니다.",
      toolCalls: [{ name: "read_file", args: {} }],
    },
    {
      text: "관련 파일을 계속 살펴보고 있습니다.",
      toolCalls: [{ name: "read_file", args: {} }],
    },
  ]);
});
