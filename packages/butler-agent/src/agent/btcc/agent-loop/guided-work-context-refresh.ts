import type { DurableWorkContext } from "../work/index.ts";
import { renderDurableWorkContext } from "./durable-work-context.ts";

/** Emits current Work facts only when the same Turn's durable context changes. */
export function createGuidedWorkContextRefresh(input: {
  initial: DurableWorkContext | null;
  load: () => Promise<DurableWorkContext | null>;
}): () => Promise<string | undefined> {
  let lastRendered = renderDurableWorkContext(input.initial, { includeResultHistory: false });
  return async () => {
    const rendered = renderDurableWorkContext(await input.load(), { includeResultHistory: false });
    if (rendered === lastRendered) return undefined;
    lastRendered = rendered;
    return rendered
      ? `Updated current Work context for this same Work:\n${rendered}`
      : "Updated current Work context: no Work is currently bound to this Turn.";
  };
}
