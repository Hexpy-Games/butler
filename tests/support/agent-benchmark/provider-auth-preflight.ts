import type { CommandExecutor } from "./command.ts";
import type { ProviderAuthPreflight } from "./paired-contract.ts";

export async function observeProviderAuthPreflight(executor: CommandExecutor, sourceRoot: string): Promise<ProviderAuthPreflight> {
  const signal = new AbortController().signal;
  const run = async (args: string[]) => executor.execute({ executable: "butler", args, cwd: sourceRoot,
    env: {}, timeoutMs: 10_000, signal });
  let auth, models;
  try { [auth, models] = await Promise.all([run(["auth", "status", "--json"]), run(["model", "list", "--json"])]); }
  catch { throw new Error("measurement_unavailable: Butler auth/model preflight command unavailable"); }
  if (auth.exitCode !== 0 || models.exitCode !== 0 || auth.outputComplete === false || models.outputComplete === false)
    throw new Error("measurement_unavailable: Butler auth/model preflight unavailable");
  const authData = envelopeData(auth.stdout), modelData = envelopeData(models.stdout);
  if (authData.configured !== true || authData.redacted !== true || authData.mode !== "codex_oauth" ||
      authData.source !== "CODEX_AUTH_JSON" || modelData.source !== "bundled-catalog" ||
      !Array.isArray(modelData.models) || !modelData.models.includes("openai/gpt-5.6-sol"))
    throw new Error("measurement_unavailable: managed auth or exact model unavailable");
  return { schema: "butler.provider-auth-preflight-receipt.v1", authority: "butler_auth_status_and_model_catalog",
    provider: "openai", authMode: "managed", observedProductAuthMode: "codex_oauth", model: "openai/gpt-5.6-sol",
    reasoning: "medium", executionMode: "ordinary_non_fast", modelCallability: "available", configured: true };
}

function envelopeData(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as { ok?: unknown; data?: unknown };
    if (value.ok === true && value.data && typeof value.data === "object" && !Array.isArray(value.data))
      return value.data as Record<string, unknown>;
  } catch { /* fail closed below */ }
  throw new Error("measurement_unavailable: Butler auth/model preflight output invalid");
}
