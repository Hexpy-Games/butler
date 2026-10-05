import type { InterfaceContentReferences, InterfaceTextReference } from "./copy-contract.ts";

const keys = new Set(["toolTitle", "checkingPrevious", "checkingRequest", "toolWorking", "checkingInformation", "commandExecuting", "conceptionTitle", "planningNext", "reportTitle", "conceptionSummary", "workInProgress", "toolsSummary", "workerStatus"]);

/** Decode only the public template contract; never retain arbitrary event arguments. */
export function readInterfaceContent(value: unknown): InterfaceContentReferences | undefined {
  if (!value || typeof value !== "object") return undefined;
  const result: InterfaceContentReferences = {};
  for (const field of ["title", "summary", "nextStep"] as const) {
    const raw = (value as Record<string, unknown>)[field];
    if (!raw || typeof raw !== "object") continue;
    const reference = raw as Record<string, unknown>;
    if (typeof reference.key !== "string" || !keys.has(reference.key)) continue;
    const parameters: NonNullable<InterfaceTextReference["parameters"]> = {};
    if (reference.parameters && typeof reference.parameters === "object") {
      const input = reference.parameters as Record<string, unknown>;
      for (const name of ["toolName", "target", "text", "phase"] as const) {
        if (typeof input[name] === "string") parameters[name] = input[name].slice(0, 600);
      }
      if (Array.isArray(input.tools)) parameters.tools = input.tools.slice(0, 20).flatMap(tool => {
        if (!tool || typeof tool !== "object" || typeof tool.name !== "string") return [];
        return [{ name: tool.name.slice(0, 120), ...(typeof tool.target === "string" ? { target: tool.target.slice(0, 160) } : {}) }];
      });
    }
    result[field] = { key: reference.key as InterfaceTextReference["key"], parameters };
  }
  return Object.keys(result).length ? result : undefined;
}
