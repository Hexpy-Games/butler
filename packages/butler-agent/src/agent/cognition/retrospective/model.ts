import {
  DEFAULT_MODEL_REF,
  DEFAULT_REASONING_EFFORT,
} from "../../../integrations/providers/model-catalog.ts";
import { runPromptTextWithUsage } from "../../../integrations/providers/provider.ts";
import type {
  RetrospectiveModelRunner,
  RetrospectiveModelRunnerResult,
} from "./contracts.ts";
import {
  RETROSPECTIVE_DECISION_RESPONSE_SCHEMA,
  RETROSPECTIVE_RESPONSE_SCHEMA,
} from "./response-schemas.ts";

export const defaultRetrospectiveModelRunner: RetrospectiveModelRunner = async (input) => {
  const result = await runPromptTextWithUsage({
    model: DEFAULT_MODEL_REF,
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    instructions: input.instructions,
    prompt: input.prompt,
    cacheScope: input.cacheScope,
    butlerData: input.butlerData,
    responseFormat: {
      type: "json_schema",
      name: input.kind === "evaluate"
        ? "btcc_retrospective"
        : "btcc_guidance_decisions",
      schema: input.kind === "evaluate"
        ? RETROSPECTIVE_RESPONSE_SCHEMA
        : RETROSPECTIVE_DECISION_RESPONSE_SCHEMA,
      strict: true,
    },
  });
  return { text: result.text, usage: result.usage };
};

export function normalizeModelResult(
  value: string | RetrospectiveModelRunnerResult,
): RetrospectiveModelRunnerResult {
  return typeof value === "string" ? { text: value } : value;
}
