import type { WorkerModelPreset, WorkerModelRule } from "../model-catalog.ts";
import { ANTHROPIC_SOURCE, GEMINI_SOURCE, OPENAI_SOURCE } from "./hosted-models.ts";

export function defaultWorkerModelRules(): WorkerModelRule[] {
  return workerModelPresets().find((preset) => preset.provider_id === "openai")?.runtime_supported
    ? cloneWorkerRules([
      {
        id: "deep_work",
        label: "Deep work",
        condition: "Research, feature-level development, architecture, review, and analysis",
        model: "openai/gpt-5.6-sol",
        reasoning_effort: "high",
        enabled: true,
      },
      {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple coding, search, local inspection, formatting, and tool calls",
        model: "openai/gpt-5.6-terra",
        reasoning_effort: "medium",
        enabled: true,
      },
    ])
    : [];
}

export function workerModelPresets(): WorkerModelPreset[] {
  const presets = [
    {
      provider_id: "openai",
      provider_label: "OpenAI",
      runtime_supported: true,
      source_url: OPENAI_SOURCE,
      deep_work: {
        id: "deep_work",
        label: "Deep work",
        condition: "Research, feature-level development, architecture, review, and analysis",
        model: "openai/gpt-5.6-sol",
        reasoning_effort: "high",
        enabled: true,
      },
      routine_work: {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple coding, search, local inspection, formatting, and tool calls",
        model: "openai/gpt-5.6-terra",
        reasoning_effort: "medium",
        enabled: true,
      },
    },
    {
      provider_id: "anthropic",
      provider_label: "Anthropic",
      runtime_supported: true,
      source_url: ANTHROPIC_SOURCE,
      deep_work: {
        id: "deep_work",
        label: "Deep work",
        condition: "Research, feature-level development, architecture, review, and analysis",
        model: "anthropic/claude-opus-4-7",
        reasoning_effort: "high",
        enabled: true,
      },
      routine_work: {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple coding, search, local inspection, formatting, and tool calls",
        model: "anthropic/claude-sonnet-4-6",
        reasoning_effort: "medium",
        enabled: true,
      },
    },
    {
      provider_id: "google",
      provider_label: "Google",
      runtime_supported: true,
      source_url: GEMINI_SOURCE,
      deep_work: {
        id: "deep_work",
        label: "Deep work",
        condition: "Research, feature-level development, architecture, review, and analysis",
        model: "google/gemini-3.1-pro-preview",
        reasoning_effort: "high",
        enabled: true,
      },
      routine_work: {
        id: "routine_work",
        label: "Routine work",
        condition: "Simple coding, search, local inspection, formatting, and tool calls",
        model: "google/gemini-2.5-pro",
        reasoning_effort: "medium",
        enabled: true,
      },
    },
  ] satisfies WorkerModelPreset[];

  return presets.map((preset) => ({
    ...preset,
    deep_work: { ...preset.deep_work },
    routine_work: { ...preset.routine_work },
  }));
}

function cloneWorkerRules(rules: WorkerModelRule[]): WorkerModelRule[] {
  return rules.map((rule) => ({ ...rule }));
}
