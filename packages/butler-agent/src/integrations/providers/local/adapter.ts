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
  async runRound(request) {
    const [{ resolveEffectiveModelRef, resolveLocalModelConfig }, { runLocalModelRound }] = await Promise.all([
      import("../shared/model-routing.ts"),
      import("./model-round.ts"),
    ]);
    const model = resolveEffectiveModelRef(request.model);
    return await runLocalModelRound(resolveLocalModelConfig(model), { ...request, model });
  },
});
