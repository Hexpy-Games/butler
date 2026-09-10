import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateNewChatBriefings,
  type NewChatBriefingModelRunnerInput,
} from "../../packages/butler-agent/src/agent/cognition/consolidation/new-chat-briefing.ts";
import {
  readConsolidationCheckpoint,
  runCognitionConsolidationCycle,
} from "../../packages/butler-agent/src/agent/cognition/consolidation/cycle.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import {
  captureProfileCandidatesFromTranscriptsWithModel,
  consolidateProfileCandidates,
  importProfileCandidatesFromThirdPartyDumpWithModel,
  readRuntimeProfileProjection,
  renderRuntimeProfileProjectionPrompt,
  writeProfilingConsentSnapshot,
} from "../../packages/butler-agent/src/personalization/profiling.ts";
import {
  acquireConsolidationLock,
  consolidationLockPath,
  releaseConsolidationLock,
} from "../../packages/butler-agent/src/agent/cognition/memory/scripts/lib/lock.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(settings: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "butler-briefing-policy-"));
  roots.push(root);
  writeFileSync(join(root, "butler.config.json"), `${JSON.stringify(settings)}\n`, "utf8");
  return root;
}

function validBriefingJson(): string {
  return JSON.stringify({
    moment: "Now",
    title: "Briefing",
    title_variants: {
      morning: "Morning",
      afternoon: "Afternoon",
      evening: "Evening",
      night: "Night",
    },
    description: "A concise briefing.",
    suggestions: [
      { id: "one", title: "One", description: "First", text: "First", source_kind: "current_interest" },
      { id: "two", title: "Two", description: "Second", text: "Second", source_kind: "current_interest" },
      { id: "three", title: "Three", description: "Third", text: "Third", source_kind: "current_interest" },
      { id: "four", title: "Four", description: "Fourth", text: "Fourth", source_kind: "current_interest" },
    ],
  });
}

async function expectConfigurationSkip(settings: Record<string, unknown>) {
  const butlerData = fixture(settings);
  let calls = 0;
  const result = await generateNewChatBriefings({
    butlerData,
    runId: "cr_policy_skip",
    modelRunner: async () => {
      calls += 1;
      return validBriefingJson();
    },
  });
  expect(calls).toBe(0);
  expect(result).toMatchObject({
    outcome: "configuration_unavailable",
    generated_count: 0,
    failed_count: 0,
    model_ref: null,
    reasoning_effort: null,
  });
  expect(result.skip_reason).toBeString();
  expect(result.model_usage.request_count).toBe(0);
}

test("gateway-profile-only and unrelated settings fail closed before briefing provider entry", async () => {
  await expectConfigurationSkip({ gateway_profile: "electron" });
  await expectConfigurationSkip({ gateway_profile: "electron", language: "ko" });
});

test("a missing model or missing reasoning effort is a typed no-request skip", async () => {
  await expectConfigurationSkip({ model: "openai/gpt-5.6-sol" });
  await expectConfigurationSkip({ reasoning_effort: "medium" });
  await expectConfigurationSkip({ consolidation_model: "openai/gpt-5.6-sol" });
  await expectConfigurationSkip({ consolidation_reasoning_effort: "medium" });
});

test("invalid, stale, and unsupported policy values fail closed", async () => {
  await expectConfigurationSkip({ model: "openai/gpt-retired", reasoning_effort: "medium" });
  await expectConfigurationSkip({ model: "local/removed-model", reasoning_effort: "medium" });
  await expectConfigurationSkip({
    model: "openai/gpt-5.6-sol",
    reasoning_effort: "medium",
    models: {
      registered: [{
        provider_id: "openai",
        model_id: "gpt-5.6-sol",
        auth_type: "api_key",
        credential_id: "cred_deleted",
      }],
    },
  });
  await expectConfigurationSkip({ model: "openai/gpt-5.4-mini", reasoning_effort: "max" });
  await expectConfigurationSkip({ model: "openai/gpt-5.6-sol", reasoning_effort: "extreme" });
});

test("explicit gpt-5.6-sol medium is used exactly once without rewriting policy", async () => {
  const butlerData = fixture({
    gateway_profile: "electron",
    model: "openai/gpt-5.6-sol",
    reasoning_effort: "medium",
  });
  const requests: NewChatBriefingModelRunnerInput[] = [];
  const result = await generateNewChatBriefings({
    butlerData,
    runId: "cr_sol_medium",
    now: new Date("2026-08-14T01:00:00.000Z"),
    modelRunner: async (input) => {
      requests.push(input);
      return validBriefingJson();
    },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "medium",
  });
  expect(result).toMatchObject({
    outcome: "completed",
    model_ref: "openai/gpt-5.6-sol",
    reasoning_effort: "medium",
    generated_count: 1,
    failed_count: 0,
  });
});

test("the explicit consolidation default sentinel uses the explicit default model policy", async () => {
  const butlerData = fixture({
    consolidation_model: "default",
    consolidation_reasoning_effort: "medium",
    model: "openai/gpt-5.6-sol",
  });
  const requests: NewChatBriefingModelRunnerInput[] = [];
  await generateNewChatBriefings({
    butlerData,
    runId: "cr_default_policy",
    modelRunner: async (input) => {
      requests.push(input);
      return validBriefingJson();
    },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    model: "openai/gpt-5.6-sol",
    reasoningEffort: "medium",
  });
});

test("another explicit valid user policy remains honored", async () => {
  const butlerData = fixture({
    consolidation_model: "openai/gpt-5.4-mini",
    consolidation_reasoning_effort: "high",
    model: "openai/gpt-5.6-sol",
    reasoning_effort: "medium",
  });
  const requests: NewChatBriefingModelRunnerInput[] = [];
  await generateNewChatBriefings({
    butlerData,
    runId: "cr_other_policy",
    modelRunner: async (input) => {
      requests.push(input);
      return validBriefingJson();
    },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    model: "openai/gpt-5.4-mini",
    reasoningEffort: "high",
  });
});

test("cycle checkpoints a configuration skip as complete and resume does not retry it", async () => {
  const butlerData = fixture({ gateway_profile: "electron" });
  let calls = 0;
  let releasePhase!: () => void;
  let phaseEntered!: () => void;
  const entered = new Promise<void>((resolve) => { phaseEntered = resolve; });
  const blocked = new Promise<void>((resolve) => { releasePhase = resolve; });
  let held = false;
  const input = {
    butlerData,
    runId: "cr_configuration_skip_restart",
    newChatBriefingModelRunner: async () => {
      calls += 1;
      return validBriefingJson();
    },
    phaseHook: async () => {
      if (held) return;
      held = true;
      phaseEntered();
      await blocked;
    },
  };
  const firstRun = runCognitionConsolidationCycle(input);
  await entered;
  const overlap = await runCognitionConsolidationCycle({ ...input, resume: true });
  expect(overlap.status).toBe("lock_held");
  releasePhase();
  const first = await firstRun;
  expect(first.status).toBe("completed");
  expect(first.phases.find((phase) => phase.phase === "new_chat_briefing")).toMatchObject({
    status: "ok",
    metrics: {
      outcome: "configuration_unavailable",
      failed_count: 0,
    },
  });
  expect(calls).toBe(0);
  expect(readConsolidationCheckpoint(butlerData, input.runId)).toMatchObject({
    status: "completed",
    completed_phases: expect.arrayContaining(["new_chat_briefing"]),
  });

  const second = await runCognitionConsolidationCycle({ ...input, resume: true });
  expect(second.status).toBe("completed");
  expect(second.phases).toHaveLength(0);
  expect(calls).toBe(0);
  expect(JSON.parse(readFileSync(second.summary_path, "utf8"))).toMatchObject({ status: "completed" });
});

test("briefing consumes the same eligible short projection without stable-entry bypass", async () => {
  const butlerData = fixture({
    model: "openai/gpt-5.6-sol",
    reasoning_effort: "medium",
  });
  writeProfilingConsentSnapshot(butlerData, { mode: "deep" });
  const store = new AgentConversationStore({ butlerData });
  try {
    const turn = store.beginTurn({
      gateway: "app", externalSessionId: "briefing-profile", sessionId: "cs_briefing_profile",
      actor: "user", now: new Date().toISOString(),
    });
    store.appendUserMessage({
      sessionId: "cs_briefing_profile", turnId: turn.id, messageId: "cm_briefing_profile",
      text: "Please answer concisely and verify the result.", originKind: "user_input",
      now: new Date().toISOString(),
    });
  } finally {
    store.close();
  }
  await captureProfileCandidatesFromTranscriptsWithModel(butlerData, {
    modelRunner: async (input) => {
      const prompt = JSON.parse(input.prompt) as { observations: Array<{ ref: string }> };
      return JSON.stringify({ candidates: [{
        category: "communication",
        facet: "explanation_preference",
        summary: "Prefers concise verified answers.",
        butler_should: ["Answer concisely and verify the result."],
        source_type: "explicit",
        confidence: "high",
        evidence_refs: [prompt.observations[0]!.ref],
        decay_policy: "days_30",
      }] });
    },
  });
  consolidateProfileCandidates(butlerData);
  await importProfileCandidatesFromThirdPartyDumpWithModel(butlerData, {
    source: "chatgpt",
    text: "Imported durable collaboration preference.",
    modelRunner: async (input) => {
      const evidenceRef = input.prompt.match(/Import ref: ([^\n]+)/u)?.[1] ?? "";
      return JSON.stringify({ candidates: [{
        category: "relationships",
        facet: "collaboration_preferences",
        summary: "Prefers collaborators who surface missed assumptions.",
        butler_should: ["Surface missed assumptions."],
        temporal_scope: "durable",
        decay_policy: "reinforce_or_decay",
        source_type: "inference",
        confidence: "high",
        evidence_refs: [evidenceRef],
      }] });
    },
  });
  const projection = readRuntimeProfileProjection(butlerData)!;
  expect(renderRuntimeProfileProjectionPrompt(projection)).toContain("Answer concisely and verify the result.");

  let briefingProfile: unknown = null;
  let profileSummaries: unknown = null;
  const result = await generateNewChatBriefings({
    butlerData,
    runId: "cr_briefing_profile_projection",
    modelRunner: async (input) => {
      const gatePath = consolidationLockPath(butlerData);
      const lease = acquireConsolidationLock(gatePath, { purpose: "briefing_model_probe" });
      expect(lease).not.toBeNull();
      releaseConsolidationLock(gatePath, lease!);
      const prompt = JSON.parse(input.prompt) as {
        runtime_projection: unknown;
        profile_summaries: unknown;
      };
      briefingProfile = prompt.runtime_projection;
      profileSummaries = prompt.profile_summaries;
      return validBriefingJson();
    },
  });
  expect(result.generated_count).toBe(1);
  expect(briefingProfile).toMatchObject({
    how_to_answer: expect.arrayContaining(["Answer concisely and verify the result."]),
    how_to_collaborate: expect.arrayContaining(["Surface missed assumptions."]),
  });
  expect(profileSummaries).toEqual([]);

  const stale = await generateNewChatBriefings({
    butlerData,
    runId: "cr_briefing_stale_projection",
    modelRunner: async () => {
      writeProfilingConsentSnapshot(butlerData, { mode: "off" });
      return validBriefingJson();
    },
  });
  expect(stale).toMatchObject({ generated_count: 0, failed_count: 1 });
});
