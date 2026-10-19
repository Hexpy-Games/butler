import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeAppServerHandle } from "./native-app-server.ts";

/** Registers "Stub B" (`stub-b`) on the stub agent's model server beside the default "Stub". */
export async function registerSecondModel(server: NativeAppServerHandle): Promise<void> {
  const config = JSON.parse(readFileSync(join(server.butlerData, "butler.config.json"), "utf8"));
  await server.api("/model-catalog/local-models", { method: "POST", body: JSON.stringify({
    provider_id: "local", api_type: "openai_compatible", platform: "custom", server_url: config.models.local[0].server_url,
    model_id: "stub-b", display_name: "Stub B", context_window_tokens: 128000, source: "manual",
  }) });
}
