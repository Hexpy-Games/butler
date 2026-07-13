import type { ModelRequestContextPlan } from "./request-context-admission.ts";

export interface ModelRequestContextAdmissionMetric {
  category: "runtime";
  name: "model_request_context_admission";
  status: "ok" | "skipped";
  value: number;
  unit: "token_upper_bound";
  dimensions: Record<string, string | number>;
}

export function modelRequestContextAdmissionMetric(
  plan: ModelRequestContextPlan,
): ModelRequestContextAdmissionMetric {
  return {
    category: "runtime",
    name: "model_request_context_admission",
    status: plan.admission === "admitted" ? "ok" : "skipped",
    value: plan.compiled_input_tokens,
    unit: "token_upper_bound",
    dimensions: {
      model_ref: plan.model_ref,
      measurement: plan.measurement,
      admission: plan.admission,
      generation: plan.generation,
      context_window_tokens: plan.context_window_tokens,
      requested_output_tokens: plan.requested_output_tokens,
      input_capacity_tokens: plan.input_capacity_tokens,
      provider_envelope_tokens: plan.provider_envelope_tokens,
      required_atom_count: plan.required_atoms.length,
      optional_atom_count: plan.optional_atoms.length,
    },
  };
}
