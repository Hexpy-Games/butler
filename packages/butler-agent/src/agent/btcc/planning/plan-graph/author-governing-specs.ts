import { contentRef, requireString, type ContentRef } from "../../core/index.ts";
import type { AvailableSpecRevision } from "../contracts.ts";
import { rejectPlanningProposal } from "./planning-proposal-defect.ts";

export function authorGoverningSpecs(
  specifications: unknown,
  selections: unknown,
  available: AvailableSpecRevision[],
) {
  const authoredSpecs = authorSpecs(specifications);
  return {
    authoredSpecs,
    governingSpecRefs: selectGoverningSpecs(selections, available, authoredSpecs),
  };
}

function authorSpecs(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    rejectPlanningProposal("specifications_invalid", "Planning specifications must be an array");
  }
  const specs = value.map((item, index) => {
    const draft = item as Record<string, unknown>;
    const body = {
      logicalId: requireString(draft.logicalId, `specifications[${index}].logicalId`),
      title: requireString(draft.title, `specifications[${index}].title`),
      body: requireString(draft.body, `specifications[${index}].body`),
    };
    return { ref: contentRef("spec-revision", body), ...body };
  });
  if (new Set(specs.map((spec) => spec.logicalId)).size !== specs.length) {
    rejectPlanningProposal(
      "specification_id_duplicate",
      "Planning specifications contain duplicate logical IDs",
    );
  }
  return specs;
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
