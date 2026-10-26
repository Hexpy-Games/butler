import { workerProfileTextPatch } from "./workerProfileTextPatch";
// test-category: pure-logic
import type { AppModelSummary, ReasoningEffort, WorkerProfile } from "@/app/types.ts";
import { expect, test } from "bun:test";
import { WORKER_PROFILE_BUILTIN_JOBS, commitWorkerProfileCustomJob, selectWorkerProfileJob, selectWorkerProfileModel } from "./workerProfileUpdates";

function model(
  modelRef: string,
  displayName: string,
  efforts: ReasoningEffort[],
  defaultEffort: ReasoningEffort,
): AppModelSummary {
  const [providerId, modelId] = modelRef.split("/");
  return {
    provider_id: providerId ?? "openai",
    provider_label: "OpenAI",
    model_id: modelId ?? modelRef,
    model_ref: modelRef,
    display_name: displayName,
    status: "available",
    default_reasoning_effort: defaultEffort,
    reasoning_efforts: efforts,
    token_estimator: "character_estimate",
    runtime_supported: true,
  };
}

const m1 = model("openai/m1", "M1 mini", ["none", "low", "medium"], "medium");
const m2 = model("openai/m2", "M2 large", ["medium", "high"], "high");
const localBudgeted = {
  ...model("local/lm", "LM", ["none", "low"], "low"),
  provider_id: "local",
  provider_label: "Local",
  local_reasoning_budget_ratio: 0.25,
};
const localPlain = {
  ...model("local/lm", "LM", ["none", "low"], "low"),
  provider_id: "local",
  provider_label: "Local",
};


test("transition helpers cover job selection and model reasoning rules", () => {
  for (const job of WORKER_PROFILE_BUILTIN_JOBS) {
    expect(selectWorkerProfileJob(job)).toEqual({
      persistent: true,
      job: { kind: "builtin", job },
    });
  }
  expect(selectWorkerProfileJob("custom")).toEqual({ persistent: false });
  expect(selectWorkerProfileJob("unknown")).toBeNull();

  expect(commitWorkerProfileCustomJob("   ")).toBeNull();
  expect(commitWorkerProfileCustomJob("")).toBeNull();
  expect(commitWorkerProfileCustomJob("a".repeat(161))).toBeNull();
  expect(commitWorkerProfileCustomJob("a".repeat(160))).toEqual({
    kind: "custom",
    text: "a".repeat(160),
  });
  expect(commitWorkerProfileCustomJob("  Security audit  ")).toEqual({
    kind: "custom",
    text: "Security audit",
  });

  expect(selectWorkerProfileModel([m1], m1.model_ref, "low")).toEqual({
    model: m1.model_ref,
    reasoning_effort: "low",
  });
  expect(selectWorkerProfileModel([m1], m1.model_ref, "none")).toEqual({
    model: m1.model_ref,
    reasoning_effort: "none",
  });
  expect(selectWorkerProfileModel([m2], m2.model_ref, "medium")).toEqual({
    model: m2.model_ref,
    reasoning_effort: "medium",
  });
  expect(selectWorkerProfileModel([m2], m2.model_ref, "low")).toEqual({
    model: m2.model_ref,
    reasoning_effort: "high",
  });
  expect(selectWorkerProfileModel([localBudgeted], localBudgeted.model_ref, "none")).toEqual({
    model: localBudgeted.model_ref,
    reasoning_effort: "low",
  });
  expect(selectWorkerProfileModel([localPlain], localPlain.model_ref, "none")).toEqual({
    model: localPlain.model_ref,
    reasoning_effort: "none",
  });
});


// test-category: pure-logic
test("unchanged valid and empty optional blurs emit zero patches", () => {
  const profile: WorkerProfile = { id: "w1", label: "Worker 1", enabled: true, job: { kind: "custom", text: "Review" }, model: "openai/m1", reasoning_effort: "medium" };
  for (const [field, value] of [["label", " Worker 1 "], ["domain", " "], ["prompt", ""], ["job", " Review "]] as const) expect(workerProfileTextPatch(profile, field, value)).toBeNull();
  expect(workerProfileTextPatch(profile, "label", "")).toBeNull();
  expect(workerProfileTextPatch(profile, "job", "a".repeat(161))).toBeNull();
  expect(workerProfileTextPatch(profile, "domain", " Security ")).toEqual({ domain: "Security" });
  expect(workerProfileTextPatch({ ...profile, domain: "Security" }, "domain", " ")).toEqual({ domain: undefined });
  expect(workerProfileTextPatch(profile, "label", " Juno ")).toEqual({ label: "Juno" });
  expect(workerProfileTextPatch(profile, "prompt", " Verify ")).toEqual({ prompt: "Verify" });
  expect(workerProfileTextPatch(profile, "job", " Debug ")).toEqual({ job: { kind: "custom", text: "Debug" } });
});
