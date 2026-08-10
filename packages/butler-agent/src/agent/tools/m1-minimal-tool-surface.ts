export const M1_MINIMAL_TOOL_SURFACE_FLAG = "BUTLER_M1_MINIMAL_TOOL_SURFACE" as const;
export const M1_MINIMAL_TOOL_SURFACE_FLAG_REVISION = "m1-t2-v1" as const;

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);

export function isM1MinimalToolSurfaceEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return TRUE_VALUES.has(env[M1_MINIMAL_TOOL_SURFACE_FLAG]?.trim().toLowerCase() ?? "");
}
