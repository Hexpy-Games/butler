import { contentRef, type AuthoringContractBinding } from "../core/index.ts";

const COMPACT_CONTRACTS = [
  {
    contractId: "SPEC-BTCC-WORK-AUTHORING-CONTRACT",
    applicableRules: [
      "Preserve the immutable GoalContract and current governing authority.",
      "Every authored Spec declares parentId and concernId in reviewed bytes; use specParentRootId for a project-root Spec and an exact Spec logical id for a child.",
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
      "Implement the accepted Goal artifactPersistence exactly: required includes a repository-promotion Task and lifecycle; not_required includes neither.",
      "Declare task-bound external EffectIntents, structured risks and assumptions, and exact integration criteria.",
      "Separate the shared artifact workspace from each Task's mutation authority: workspacePath names the shared baseline and promotion root, while mutationScope is read_only or exact contained writable paths.",
      "Plan paths are relative to the admitted workspace scope: use '.' for that exact root and never copy the absolute admitted workspace path into workspacePath, repository-promotion targetPath, or writablePaths.",
      "A Task that observes or extends a predecessor WorkspaceRevision remains workspace_artifact on the exact same workspacePath; dependent Tasks may and usually should have different mutationScope values.",
      "Use mutationScope read_only for verification that must inspect accepted workspace bytes without persisting changes. Use contained_paths for implementation and declare only the paths owned by that Task.",
      "The workspace or writable path '.' is valid only when one cohesive outcome truly owns that complete root; never widen to it by convenience.",
      "When no repository-promotion Task exists, promotionSelectors and integrationCriteria are both empty; ordinary Task criteria own non-promotion verification.",
      "For repository change, implementation and integration Tasks share workspacePath, the repository_promotion Task uses that root as targetPath, and promotion directly depends on integration.",
      "Reporting is owned by BTCC Reporting; create a report-file Task only when a durable report artifact is an explicit Goal outcome.",
      "That shared target identifies one external baseline; Execution provisions a distinct ProgramArtifactWorkspace from it, so Planning Review must not demand different source and promotion target scopes.",
      "Each promotion selector names all implementation Tasks, its integration Task, and its promotion Task; its one integration criterion names exactly implementation plus integration as participants with the same integration and promotion ids.",
      "Each external-effect Task has an EffectIntent; a repository-promotion Task has exactly one repository_promotion EffectIntent and no other Task owns it.",
      "The Plan declares the reviewed selector, target, baseline policy, and journaled_complete_target_exchange_v1 protocol; runtime contracts own workspace provisioning, journal storage and transitions, crash reconciliation, and snapshot canonicalization, so do not re-specify them per Plan.",
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
