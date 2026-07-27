import type { PromptProhibitionId } from "../../core/prompt-contract.ts";

const PROHIBITIONS = {
  no_successor_choice: "Do not choose, name, or activate a semantic successor; submit only an available typed exit.",
  no_runtime_semantic_judgment: "Do not delegate intent, sufficiency, fidelity, correction kind, or deferral meaning to runtime validation.",
  no_model_substitution: "Do not probe, select, or switch models or controls and do not route by model answerability.",
  no_heuristic_route: "Do not decide route or completion from keywords, regex, length, counts, elapsed time, or tool names.",
  no_generic_assurance_layer:
    "Do not invent a generic assurance layer; use concrete domain records and observations.",
  no_hidden_retry_loop: "Do not retry unchanged semantic output by count or hide candidate correction inside the phase.",
  no_mutation: "Do not mutate Work, target, authority, or semantic state in this phase.",
  no_self_review: "Do not certify your own candidate where an explicit review phase owns that decision.",
  no_repair: "Do not implement or mutate a correction while reviewing or consolidating.",
  no_learning_on_delivery_path: "Do not generate learning or profile mutations before canonical answer delivery.",
} as const satisfies Record<PromptProhibitionId, string>;

export function resolveProhibitionInstructions(
  ids: readonly PromptProhibitionId[],
) {
  return ids.map((id) => ({ id, instruction: requireProhibition(id) }));
}

function requireProhibition(id: PromptProhibitionId): string {
  const instruction = PROHIBITIONS[id];
  if (!instruction) throw new Error(`Unknown BTCC prompt prohibition: ${id}`);
  return instruction;
}
