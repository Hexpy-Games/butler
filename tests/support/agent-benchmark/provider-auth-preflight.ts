import { resolveExecutable, safeEnvironment, type CommandExecutor } from "./command.ts";
import { resolve } from "node:path";
import type { ProviderAuthPreflight } from "./paired-contract.ts";

export async function observeProviderAuthPreflight(
  executor: CommandExecutor,
  sourceRoot: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<ProviderAuthPreflight> {
  const signal = new AbortController().signal;
  const environment = safeEnvironment({}, sourceEnvironment);
  const locatedExecutable = resolveExecutable("butler", environment);
  if (!locatedExecutable) throw new Error("measurement_unavailable: Butler CLI executable unavailable");
  const executable = resolve(locatedExecutable);
  const run = async (args: string[]) => executor.execute({ executable, args, cwd: sourceRoot,
    env: environment, timeoutMs: 10_000, signal });
  let auth, models;
  try { [auth, models] = await Promise.all([run(["auth", "status", "--json"]), run(["model", "list", "--json"])]); }
  catch { throw new Error("measurement_unavailable: Butler auth/model preflight command unavailable"); }
  if (auth.exitCode !== 0 || models.exitCode !== 0 || auth.outputComplete === false || models.outputComplete === false)
    throw new Error("measurement_unavailable: Butler auth/model preflight unavailable");
  const authData = envelopeData(auth.stdout), modelData = envelopeData(models.stdout);
  const observedAuth = managedAuth(authData);
  if (!observedAuth || modelData.source !== "bundled-catalog" ||
      !Array.isArray(modelData.models) || !modelData.models.includes("openai/gpt-5.6-sol"))
    throw new Error("measurement_unavailable: managed auth or exact model unavailable");
  return { schema: "butler.provider-auth-preflight-receipt.v1", authority: "butler_auth_status_and_model_catalog",
    provider: "openai", authMode: "managed", observedProductAuthMode: observedAuth.mode,
    observedProductAuthSource: observedAuth.source, model: "openai/gpt-5.6-sol",
    reasoning: "medium", executionMode: "ordinary_non_fast", modelCallability: "available", configured: true };
}

function managedAuth(value: Record<string, unknown>): {
  mode: "codex_oauth" | "codex_subscription";
  source: "CODEX_AUTH_JSON" | "BUTLER_CODEX_AUTH_PROFILE";
} | null {
  if (value.configured !== true || value.redacted !== true) return null;
  if (value.mode === "codex_oauth" && value.source === "CODEX_AUTH_JSON")
    return { mode: "codex_oauth", source: "CODEX_AUTH_JSON" };
  if (value.mode === "codex_subscription" && value.source === "BUTLER_CODEX_AUTH_PROFILE")
    return { mode: "codex_subscription", source: "BUTLER_CODEX_AUTH_PROFILE" };
  return null;
}

function envelopeData(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as { ok?: unknown; data?: unknown };
    if (value.ok === true && value.data && typeof value.data === "object" && !Array.isArray(value.data))
      return value.data as Record<string, unknown>;
  } catch { /* fail closed below */ }
  throw new Error("measurement_unavailable: Butler auth/model preflight output invalid");
}
