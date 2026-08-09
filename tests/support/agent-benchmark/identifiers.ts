import type { EffectiveAgentConfig } from "./contracts.ts";

/** Accepts only bounded, single-field identifiers suitable for reports. */
export function sanitizeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  }) || /[|`]/u.test(normalized)) return null;
  if (/(?:api[_-]?key|token|password|secret)\s*[:=]|(?:\/Users\/|\/home\/|[A-Z]:\\)/iu.test(normalized)) return null;
  return /^[\p{L}\p{N}_.:@/+~-]+$/u.test(normalized) ? normalized : null;
}

export function sanitizeEffectiveConfig(
  config: Partial<EffectiveAgentConfig>,
): Partial<EffectiveAgentConfig> {
  const sanitized: Partial<EffectiveAgentConfig> = { ...config };
  for (const key of ["model", "reasoning", "provider", "variant"] as const) {
    if (key in config) sanitized[key] = sanitizeIdentifier(config[key]);
  }
  if (config.permissions !== undefined) sanitized.permissions = sanitizeIdentifier(config.permissions) ?? "benchmark-configuration-unavailable";
  if (config.tools !== undefined) sanitized.tools = config.tools.map((tool) => sanitizeIdentifier(tool)).filter((tool): tool is string => tool !== null);
  return sanitized;
}
