import { defineProviderAdapter } from "../shared/adapter-definition.ts";

export const LOCAL_PROVIDER_ADAPTER = defineProviderAdapter({
  providerId: "local",
  catalog: [],
  structuredDecisionTransport: null,
  async runPrompt(options) {
    const [{ resolveEffectiveModelRef }, { runLocalPromptText }] = await Promise.all([
      import("../shared/model-routing.ts"),
      import("./runtime.ts"),
    ]);
    const model = resolveEffectiveModelRef(options.model);
    return {
      text: await runLocalPromptText({ ...options, model }),
      model,
      usage: null,
    };
  },
  async runFunctionToolPrompt(options) {
    const [{ resolveEffectiveModelRef }, { runLocalFunctionToolPromptText }] = await Promise.all([
      import("../shared/model-routing.ts"),
      import("./runtime.ts"),
    ]);
    const model = resolveEffectiveModelRef(options.model);
    return await runLocalFunctionToolPromptText({ ...options, model });
  },
});
