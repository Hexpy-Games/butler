import type { UpdateApplyRequest, UpdateCheckRequest, UpdateComponentId } from "./runtime-contract.ts";

export function isUpdateCheckRequest(
  value: unknown,
): value is UpdateCheckRequest {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    !Object.keys(input).every((key) =>
      ["component", "components", "channel"].includes(key),
    )
  ) {
    return false;
  }
  if (
    "component" in input &&
    input.component !== undefined &&
    !isUpdateComponentId(input.component)
  )
    return false;
  if (
    "components" in input &&
    input.components !== undefined &&
    (!Array.isArray(input.components) ||
      !input.components.every(isUpdateComponentId))
  ) {
    return false;
  }
  if (
    "channel" in input &&
    input.channel !== undefined &&
    typeof input.channel !== "string"
  )
    return false;
  return true;
}

export function isUpdateApplyRequest(
  value: unknown,
): value is UpdateApplyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    !Object.keys(input).every((key) =>
      ["component", "channel", "dry_run"].includes(key),
    )
  ) {
    return false;
  }
  if (!isUpdateComponentId(input.component)) return false;
  if (
    "channel" in input &&
    input.channel !== undefined &&
    typeof input.channel !== "string"
  )
    return false;
  if (
    "dry_run" in input &&
    input.dry_run !== undefined &&
    typeof input.dry_run !== "boolean"
  )
    return false;
  return true;
}

function isUpdateComponentId(value: unknown): value is UpdateComponentId {
  return value === "service" || value === "app";
}
