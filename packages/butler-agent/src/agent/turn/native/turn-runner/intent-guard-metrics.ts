import { recordOperationalMetric } from "../../../../operations/metrics/operational-metrics.ts";
import type { SessionRole } from "../../../../test-support/harness/contracts.ts";
import type { RuntimeIntentGuardName } from "../../../policy/runtime-policy.ts";

export function recordIntentGuardMetric(input: {
  butlerData: string;
  role: SessionRole;
  runtime: string;
  model: string;
  guard: RuntimeIntentGuardName;
  detail: string;
}): void {
  recordOperationalMetric({
    category: "runtime",
    name: "intent_guard",
    status: "ok",
    dimensions: {
      role: input.role,
      runtime: input.runtime,
      model: input.model,
      guard: input.guard,
      detail: input.detail,
    },
  }, { butlerData: input.butlerData });
}
