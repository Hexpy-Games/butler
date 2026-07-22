import { contentRef, type AuthoringContractBinding } from "../core/index.ts";

const COMPACT_CONTRACTS = [
  {
    contractId: "SPEC-BTCC-WORK-AUTHORING-CONTRACT",
    applicableRules: [
      "Preserve the immutable GoalContract and current governing authority.",
      "A Work is a cohesive product outcome, never a phase, file bucket, or agent assignment.",
      "A Task is the smallest independently executable and reviewable outcome.",
      "Every required Goal outcome is covered exactly by observable criteria and questions.",
      "Implementation repair preserves the accepted graph; graph changes require governing review.",
    ],
  },
  {
    contractId: "SPEC-BTCC-PLANNING-RECORD-CONTRACT",
    applicableRules: [
      "Author one complete acyclic Work and Task graph with exact dependency order.",
      "Bind every criterion and verification question to its Goal fields and required outcome.",
      "Give every Task one exact artifact policy and bind the complete Task set to one lifecycle.",
      "Declare task-bound external EffectIntents, structured risks and assumptions, and exact integration criteria.",
      "Artifact targets are explicit contained workspace-relative paths; never select the whole workspace by default.",
      "When no repository-promotion Task exists, promotionSelectors and integrationCriteria are both empty; ordinary Task criteria own non-promotion verification.",
      "For repository change, implementation and integration Tasks are workspace_artifact Tasks with the same targetPath, and the repository_promotion Task uses that same targetPath and directly depends on integration.",
      "Each promotion selector names all implementation Tasks, its integration Task, and its promotion Task; its one integration criterion names exactly implementation plus integration as participants with the same integration and promotion ids.",
      "Each external-effect Task has an EffectIntent; a repository-promotion Task has exactly one repository_promotion EffectIntent and no other Task owns it.",
      "Planning Review judges the exact materialized candidate bytes and may require revision.",
    ],
  },
  {
    contractId: "SPEC-BTCC-WORK-LEDGER-STATE-AND-MUTATION-CONTRACT",
    applicableRules: [
      "Bind the candidate to the observed Ledger manifest revision.",
      "Only an accepted independent review may promote the exact candidate graph.",
      "Do not invent mutations, successors, or semantic defaults in storage adapters.",
    ],
  },
] as const;

export const PLANNING_AUTHORING_CONTRACTS: readonly AuthoringContractBinding[] =
  COMPACT_CONTRACTS.map((contract) => ({
    ...contract,
    revisionRef: contentRef("authoring-contract-revision", contract),
  }));
