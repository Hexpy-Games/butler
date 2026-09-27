import { expect, test } from "bun:test";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { EMPTY_MODEL_CATALOG, EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import { FIRST_RUN_TEST_MODEL } from "../../packages/butler-app/client/ui/src/app/fixtures.ts";
import { localizeSetupDiagnostics } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";
import {
  combineReadiness,
  normalizeReadiness,
  readinessFailureCode,
  readinessFromEvent,
  readinessProgress,
} from "../../packages/butler-app/client/ui/src/app/setupReadiness.ts";
import {
  MORE_CARD_IDS,
  PROVIDER_CARDS,
  localModelOptions,
  providerCardLayout,
} from "../../packages/butler-app/client/ui/src/app/setupProviders.ts";
import {
  defaultModelSettingsPatch,
  keyCheckFailure,
  routinePreset,
} from "../../packages/butler-app/client/ui/src/app/setupConnection.ts";
import type { AppModelSummary, ModelCatalogView } from "../../packages/butler-app/client/ui/src/app/types.ts";

const en = getAppCopy("en-US").firstRun;

test("local preparation gates agent readiness; a pre-#230 agent without the route counts as ready", () => {
  expect(combineReadiness({ phase: "checking" }, null)).toEqual({ status: "preparing", steps: [] });
  expect(combineReadiness({ phase: "failed", error_code: "agent_service_failed" }, null)).toEqual({
    status: "failed",
    steps: [{ id: "agent_service", status: "failed", error: { code: "agent_service_failed" } }],
  });
  expect(combineReadiness({ phase: "ready" }, "unsupported")).toEqual({ status: "ready", steps: [] });
  expect(combineReadiness({ phase: "ready" }, null).status).toBe("preparing");
  const agent = { status: "preparing" as const, steps: [
    { id: "catalog", status: "done" as const }, { id: "memory", status: "running" as const }, { id: "skills", status: "pending" as const },
  ] };
  expect(combineReadiness({ phase: "ready" }, agent)).toEqual(agent);
  expect(combineReadiness({ phase: "checking" }, agent)).toEqual({ status: "preparing", steps: agent.steps });
  expect(readinessProgress(agent)).toEqual({ done: 1, total: 3 });
  expect(readinessProgress({ status: "preparing", steps: [] })).toBeNull();
});

test("readiness payloads are validated, and failures resolve to a plain reason code", () => {
  expect(normalizeReadiness({ status: "ready", steps: [] })).toEqual({ status: "ready", steps: [] });
  expect(normalizeReadiness({ status: "bogus" })).toBeNull();
  expect(normalizeReadiness({ status: "failed", steps: [{ id: "x", status: "failed", error: { code: "network" } }, { nope: 1 }] }))
    .toEqual({ status: "failed", steps: [{ id: "x", status: "failed", error: { code: "network" } }] });
  const failed = { status: "failed" as const, steps: [{ id: "agent_service", status: "failed" as const, error: { code: "agent_service_failed" } }] };
  expect(readinessFailureCode(failed)).toBe("agent_service_failed");
  expect(readinessFailureCode({ status: "failed", steps: [] })).toBe("default");
  expect(readinessFromEvent({ type: "setup.readiness_changed", payload: { readiness: { status: "ready", steps: [] } } }))
    .toEqual({ status: "ready", steps: [] });
  expect(readinessFromEvent({ type: "setup.readiness_changed", payload: { status: "preparing", steps: [] } }))
    .toEqual({ status: "preparing", steps: [] });
  expect(readinessFromEvent({ type: "message.created", payload: {} })).toBeNull();
});

test("bug-report info is localized by the renderer, not the desktop bridge", () => {
  const localized = localizeSetupDiagnostics({
    generated_at: "t", phase: "failed",
    checks: [{ id: "agent_service", status: "failed" }, { id: "unknown_step", status: "pending" }],
    errors: [{ code: "agent_service_failed" }, { code: "setup_failed" }],
  }, getAppCopy("ko-KR").firstRun);
  expect(localized.checks.map((check) => check.label)).toEqual(["Butler Agent 서비스", "unknown_step"]);
  expect(localized.errors.map((error) => error.message)).toEqual(["백그라운드 서비스가 멈췄습니다.", "백그라운드 서비스가 응답하지 않습니다."]);
});

test("This computer joins the top tier only when a local server is reachable", () => {
  expect(providerCardLayout({ localReachable: false })).toEqual({
    top: ["chatgpt", "claude", "gemini"],
    more: ["local", ...MORE_CARD_IDS],
    localPlaceholder: true,
  });
  expect(providerCardLayout({ localReachable: true })).toEqual({
    top: ["chatgpt", "claude", "gemini", "local"],
    more: [...MORE_CARD_IDS],
    localPlaceholder: false,
  });
  expect(MORE_CARD_IDS).toHaveLength(8);
  expect(MORE_CARD_IDS.at(-1)).toBe("other");
  expect(PROVIDER_CARDS.chatgpt).toMatchObject({ kind: "signin", providerId: "openai", logo: "openai", tag: "noKey" });
  expect(PROVIDER_CARDS.kimi).toMatchObject({ kind: "key", providerId: "kimi", logo: "kimi" });
  expect(PROVIDER_CARDS.zaiApi).toMatchObject({ kind: "key", providerId: "zai-api", logo: "zai" });
  expect(PROVIDER_CARDS.other).toMatchObject({ kind: "custom", icon: "server" });
  for (const id of Object.keys(PROVIDER_CARDS) as Array<keyof typeof PROVIDER_CARDS>) {
    expect(en.providerNames[id].length).toBeGreaterThan(0);
    if (PROVIDER_CARDS[id].kind === "key") expect(PROVIDER_CARDS[id].providerId).toBeTruthy();
  }
});

test("local servers flatten into model options from reachable servers only", () => {
  const options = localModelOptions([
    { id: "ollama", label: "Ollama", base_url: "http://127.0.0.1:11434", reachable: true,
      models: [{ id: "qwen3:8b", size_bytes: 5_200_000_000 }, { id: "gemma3:12b" }] },
    { id: "lm_studio", label: "LM Studio", base_url: "http://127.0.0.1:1234", reachable: false, models: [{ id: "stale" }] },
  ]);
  expect(options.map((option) => [option.key, option.platform, option.logo, option.serverUrl])).toEqual([
    ["ollama/qwen3:8b", "ollama", "ollama", "http://127.0.0.1:11434"],
    ["ollama/gemma3:12b", "ollama", "ollama", "http://127.0.0.1:11434"],
  ]);
  expect(options[0]!.sizeLabel).toBe("5.2 GB");
  expect(options[1]!.sizeLabel).toBeUndefined();
});

function catalogWith(provider: Partial<ModelCatalogView["providers"][number]>, presets?: ModelCatalogView["worker_model_presets"]): ModelCatalogView {
  const sol: AppModelSummary = { ...FIRST_RUN_TEST_MODEL, model_id: "gpt-6-sol", model_ref: "openai/gpt-6-sol", default_reasoning_effort: "xhigh" };
  const astra: AppModelSummary = { ...FIRST_RUN_TEST_MODEL, model_id: "gpt-6-astra", model_ref: "openai/gpt-6-astra", default_reasoning_effort: "xhigh" };
  return {
    ...EMPTY_MODEL_CATALOG,
    providers: [{ provider_id: "openai", provider_label: "OpenAI", latest_model_ref: astra.model_ref, models: [astra, sol], ...provider }],
    worker_model_presets: presets ?? [],
  };
}

test("the default model is the provider's routine preset from the backend, never the top model at xhigh", () => {
  expect(routinePreset(catalogWith({ presets: { routine: { model: "openai/gpt-6-sol", effort: "medium" } } }), "openai"))
    .toMatchObject({ modelId: "gpt-6-sol", modelRef: "openai/gpt-6-sol", effort: "medium" });
  expect(routinePreset(catalogWith({ presets: { routine: { model: "gpt-6-sol", effort: "low" } } }), "openai"))
    .toMatchObject({ modelId: "gpt-6-sol", effort: "low" });
  const rule = { id: "routine_work", label: "Routine", condition: "", model: "openai/gpt-6-sol", reasoning_effort: "medium" as const, enabled: true };
  const workerPreset = { provider_id: "openai", provider_label: "OpenAI", runtime_supported: true, source_url: "", deep_work: rule, routine_work: rule };
  expect(routinePreset(catalogWith({}, [workerPreset]), "openai")).toMatchObject({ modelId: "gpt-6-sol", effort: "medium" });
  expect(routinePreset(catalogWith({}), "openai")).toBeNull();
  expect(routinePreset(catalogWith({ presets: { routine: { model: "openai/missing", effort: "medium" } } }), "openai")).toBeNull();
  expect(routinePreset(catalogWith({}), "anthropic")).toBeNull();
});

test("key check failures map error codes to invalid, no access or network", () => {
  expect(keyCheckFailure("invalid_key")).toBe("invalid");
  expect(keyCheckFailure("no_access")).toBe("noaccess");
  expect(keyCheckFailure("network")).toBe("network");
  expect(keyCheckFailure(undefined)).toBe("network");
  expect(keyCheckFailure("request_failed")).toBe("network");
});

test("the default model patch sets the chat model, effort and every worker profile", () => {
  const model: AppModelSummary = { ...FIRST_RUN_TEST_MODEL, model_ref: "anthropic/claude-sonnet-5", context_window_tokens: 200_000 };
  const patch = defaultModelSettingsPatch(EMPTY_SETTINGS, model, "medium");
  expect(patch).toMatchObject({ model: "anthropic/claude-sonnet-5", reasoning_effort: "medium", context_window_tokens: 200_000 });
  expect(patch.worker_profiles.length).toBeGreaterThan(0);
  expect(patch.worker_profiles.every((profile) => profile.model === model.model_ref && profile.reasoning_effort === "medium")).toBe(true);
});
