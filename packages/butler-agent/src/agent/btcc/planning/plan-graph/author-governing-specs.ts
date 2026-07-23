import { contentRef, requireString, type ContentRef } from "../../core/index.ts";
import type { AvailableSpecRevision } from "../contracts.ts";
import { rejectPlanningProposal } from "./planning-proposal-defect.ts";

export function authorGoverningSpecs(
  specifications: unknown,
  selections: unknown,
  available: AvailableSpecRevision[],
  rootParentId?: string,
) {
  const authoredSpecs = authorSpecs(specifications, available, rootParentId);
  return {
    authoredSpecs,
    governingSpecRefs: selectGoverningSpecs(selections, available, authoredSpecs),
  };
}

function authorSpecs(
  value: unknown,
  available: AvailableSpecRevision[],
  rootParentId?: string,
) {
  if (value === undefined) return [];
  if (!rootParentId) {
    rejectPlanningProposal(
      "specification_project_authority_missing",
      "Planning cannot author a Project Spec without project authority",
    );
  }
  if (!Array.isArray(value)) {
    rejectPlanningProposal("specifications_invalid", "Planning specifications must be an array");
  }
  const specs = value.map((item, index) => {
    const draft = item as Record<string, unknown>;
    const body = {
      logicalId: planningString(draft.logicalId, `specifications[${index}].logicalId`),
      parentId: planningString(draft.parentId, `specifications[${index}].parentId`),
      concernId: planningString(draft.concernId, `specifications[${index}].concernId`),
      title: planningString(draft.title, `specifications[${index}].title`),
      body: planningString(draft.body, `specifications[${index}].body`),
    };
    return { ref: contentRef("spec-revision", body), ...body };
  });
  if (new Set(specs.map((spec) => spec.logicalId)).size !== specs.length) {
    rejectPlanningProposal(
      "specification_id_duplicate",
      "Planning specifications contain duplicate logical IDs",
    );
  }
  validateSpecHierarchy(specs, available, rootParentId);
  return specs;
}

function planningString(value: unknown, label: string): string {
  try {
    return requireString(value, label);
  } catch {
    rejectPlanningProposal("specification_field_invalid", `${label} must be a non-empty string`);
  }
}

function validateSpecHierarchy(
  authored: Array<{ logicalId: string; parentId: string; concernId: string }>,
  available: AvailableSpecRevision[],
  rootParentId: string,
): void {
  const authoredIds = new Set(authored.map((spec) => spec.logicalId));
  const availableIds = new Set(available.map((spec) => spec.logicalId));
  const validParents = new Set([rootParentId, ...availableIds, ...authoredIds]);
  for (const spec of authored) {
    if (!validParents.has(spec.parentId)) {
      rejectPlanningProposal(
        "specification_parent_unavailable",
        `Planning Spec parent is unavailable: ${spec.parentId}`,
      );
    }
    if (spec.parentId === spec.logicalId) {
      rejectPlanningProposal(
        "specification_parent_self_reference",
        `Planning Spec cannot parent itself: ${spec.logicalId}`,
      );
    }
  }
  rejectConcernCollisions(authored, available);
  rejectParentCycles(authored, authoredIds);
}

function rejectConcernCollisions(
  authored: Array<{ logicalId: string; concernId: string }>,
  available: AvailableSpecRevision[],
): void {
  const owners = new Map(available.map((spec) => [spec.concernId, spec.logicalId] as const));
  for (const spec of authored) {
    const owner = owners.get(spec.concernId);
    if (owner && owner !== spec.logicalId) {
      rejectPlanningProposal(
        "specification_concern_conflict",
        `Planning Specs claim competing authority for ${spec.concernId}`,
      );
    }
    owners.set(spec.concernId, spec.logicalId);
  }
}

function rejectParentCycles(
  authored: Array<{ logicalId: string; parentId: string }>,
  authoredIds: Set<string>,
): void {
  const parents = new Map(authored.map((spec) => [spec.logicalId, spec.parentId] as const));
  for (const spec of authored) {
    const visited = new Set<string>();
    let cursor: string | undefined = spec.logicalId;
    while (cursor && authoredIds.has(cursor)) {
      if (visited.has(cursor)) {
        rejectPlanningProposal(
          "specification_parent_cycle",
          `Planning Spec hierarchy contains a cycle at ${cursor}`,
        );
      }
      visited.add(cursor);
      cursor = parents.get(cursor);
    }
  }
}

function selectGoverningSpecs(
  value: unknown,
  available: AvailableSpecRevision[],
  authored: Array<{ logicalId: string; ref: ContentRef }>,
): ContentRef[] {
  if (value === undefined) return authored.map((spec) => spec.ref);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    rejectPlanningProposal(
      "governing_spec_selection_invalid",
      "governingSpecSelections must be a string array",
    );
  }
  const selections = value as string[];
  if (new Set(selections).size !== selections.length) {
    rejectPlanningProposal(
      "governing_spec_selection_duplicate",
      "governingSpecSelections contains duplicates",
    );
  }
  const candidates = new Map(available.map((spec) => [spec.logicalId, spec.revisionRef] as const));
  const selected = selections.map((selection) => {
    const ref = candidates.get(selection);
    if (!ref) {
      rejectPlanningProposal(
        "governing_spec_unavailable",
        `governingSpecSelections contains an unavailable Spec: ${selection}`,
      );
    }
    return ref;
  });
  const authoredIds = new Set(authored.map((spec) => spec.logicalId));
  return [
    ...selected.filter((_ref, index) => !authoredIds.has(selections[index]!)),
    ...authored.map((spec) => spec.ref),
  ];
}
