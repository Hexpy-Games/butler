import type {
  GoalContractRecord,
  GoverningSpecApplication,
} from "./managed-contracts.ts";

export function governingSpecLogicalIds(
  contract: Pick<GoalContractRecord, "governingSpecApplications">,
): string[] {
  return contract.governingSpecApplications.map((application) =>
    application.logicalId,
  );
}

export function requireGoverningSpecApplications(
  value: unknown,
): GoverningSpecApplication[] {
  if (!Array.isArray(value)) {
    throw new Error("governingSpecApplications must be an array");
  }
  const applications = value.map((item, index) =>
    requireApplication(item, index),
  );
  const logicalIds = applications.map((application) => application.logicalId);
  if (new Set(logicalIds).size !== logicalIds.length) {
    throw new Error("governingSpecApplications contains duplicate logicalIds");
  }
  return applications;
}

function requireApplication(
  value: unknown,
  index: number,
): GoverningSpecApplication {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`governingSpecApplications[${index}] must be an object`);
  }
  const application = value as Record<string, unknown>;
  const logicalId = requireText(application.logicalId, `logicalId[${index}]`);
  const changeObligations = requireTextList(
    application.changeObligations,
    `changeObligations[${index}]`,
  );
  const preservationConstraints = requireTextList(
    application.preservationConstraints,
    `preservationConstraints[${index}]`,
  );
  if (changeObligations.length === 0 && preservationConstraints.length === 0) {
    throw new Error(
      `governingSpecApplications[${index}] has no applicable obligation`,
    );
  }
  return { logicalId, changeObligations, preservationConstraints };
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be non-empty text`);
  }
  return value.trim();
}

function requireTextList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const items = value.map((item, index) =>
    requireText(item, `${label}[${index}]`),
  );
  if (new Set(items).size !== items.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return items;
}
