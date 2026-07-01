import type { SettingsView } from "../../interface/protocol/app-protocol.ts";

const APP_WORKSPACE_REQUIRED_TOOL_NAMES = new Set([
  "run_command",
  "read_tool_output_artifact",
]);

export function appRuntimePolicy(input: {
  existing?: unknown;
  accessMode: SettingsView["access_mode"];
}): Record<string, unknown> {
  const existing = input.existing &&
      typeof input.existing === "object" &&
      !Array.isArray(input.existing)
    ? input.existing as Record<string, unknown>
    : {};
  const requestedProfiles = stringArray(existing.requiredNativeToolProfiles)
    .filter((profile) => profile !== "workspace");

  if (input.accessMode === "full_access") {
    requestedProfiles.push("workspace");
  }

  return {
    ...existing,
    accessMode: input.accessMode,
    requiredNativeTools: requiredToolsForAccessMode(
      existing.requiredNativeTools,
      input.accessMode,
    ),
    required_tools: requiredToolsForAccessMode(
      existing.required_tools,
      input.accessMode,
    ),
    requiredNativeToolProfiles: [...new Set(requestedProfiles)],
  };
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string =>
      typeof item === "string" && item.trim().length > 0,
    )
      .map((item) => item.trim())
    : [];
}

function requiredToolsForAccessMode(
  value: unknown,
  accessMode: SettingsView["access_mode"],
): string[] {
  const names = stringArray(value);
  return accessMode === "full_access"
    ? names
    : names.filter((name) => !APP_WORKSPACE_REQUIRED_TOOL_NAMES.has(name));
}
