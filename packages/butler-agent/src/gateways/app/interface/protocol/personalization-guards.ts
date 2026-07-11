import type { PersonalizationProfileMigrationRequest, PersonalizationProfileUpdateRequest, PersonalizationProfilingUpdateRequest, UpdatePersonalizationRequest } from "./personalization-contract.ts";

export function isUpdatePersonalizationRequest(
  value: unknown,
): value is UpdatePersonalizationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    !Object.keys(input).every(
      (key) =>
        key === "persona" ||
        key === "eol" ||
        key === "response_language" ||
        key === "profile" ||
        key === "profiling",
    )
  )
    return false;
  if ("persona" in input && typeof input.persona !== "string") return false;
  if ("eol" in input && typeof input.eol !== "string") return false;
  if (
    "response_language" in input &&
    input.response_language !== "en" &&
    input.response_language !== "ko"
  ) {
    return false;
  }
  if ("profile" in input && !isPersonalizationProfileUpdate(input.profile)) {
    return false;
  }
  if (
    "profiling" in input &&
    !isPersonalizationProfilingUpdate(input.profiling)
  ) {
    return false;
  }
  return true;
}

export function isPersonalizationProfileMigrationRequest(
  value: unknown,
): value is PersonalizationProfileMigrationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = new Set(["source", "text", "model"]);
  if (!Object.keys(input).every((key) => keys.has(key))) return false;
  if (typeof input.text !== "string") return false;
  if ("source" in input && typeof input.source !== "string") return false;
  if ("model" in input && typeof input.model !== "string") return false;
  return true;
}

function isPersonalizationProfileUpdate(
  value: unknown,
): value is PersonalizationProfileUpdateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = new Set([
    "butler_nickname",
    "principal_name",
    "preferred_address",
  ]);
  if (!Object.keys(input).every((key) => keys.has(key))) return false;
  return Object.values(input).every((field) => typeof field === "string");
}

function isPersonalizationProfilingUpdate(
  value: unknown,
): value is PersonalizationProfilingUpdateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = new Set([
    "mode",
    "extractor_model",
    "extractor_reasoning_effort",
    "clear_profile",
  ]);
  if (!Object.keys(input).every((key) => keys.has(key))) return false;
  if (
    "mode" in input &&
    input.mode !== "off" &&
    input.mode !== "basic" &&
    input.mode !== "deep"
  ) {
    return false;
  }
  if ("clear_profile" in input && typeof input.clear_profile !== "boolean") {
    return false;
  }
  if ("extractor_model" in input && typeof input.extractor_model !== "string") {
    return false;
  }
  if (
    "extractor_reasoning_effort" in input &&
    !["none", "low", "medium", "high", "xhigh", "max"].includes(
      String(input.extractor_reasoning_effort),
    )
  ) {
    return false;
  }
  return true;
}
