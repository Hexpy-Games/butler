import type {
  OpeningFulfillment,
  OpeningRequiredResultKind,
} from "./contracts.ts";

const MANAGED_RESULTS = new Set<OpeningRequiredResultKind>([
  "target_change",
  "persistent_artifact",
  "external_effect",
  "durable_work",
]);

export function completionModeFor(
  kind: OpeningRequiredResultKind,
): OpeningFulfillment["completionMode"] {
  if (kind === "response_content") return "answer_only";
  if (kind === "current_observation") return "bounded_observation_then_answer";
  if (kind === "turn_local_effect") return "bounded_local_effect_then_answer";
  return "managed_effect_or_artifact";
}

export function isManagedResultKind(value: unknown): value is Exclude<
  OpeningRequiredResultKind,
  "response_content" | "current_observation" | "turn_local_effect"
> {
  return typeof value === "string" && MANAGED_RESULTS.has(value as OpeningRequiredResultKind);
}
