export const ARTIFACT_PERSISTENCE_DUTIES = {
  define_artifact_persistence: [
    "Set userArtifactTargetRequirement to",
    "reviewed_artifact_bytes_at_admitted_target_required only when Goal success",
    "requires user-requested, reviewed product bytes to persist at an admitted",
    "target. Transient observations, answer content, external facts or effect receipts,",
    "and internally persisted lifecycle records are not product artifacts, independent",
    "of route, Task, tool, or storage. Otherwise use no_user_artifact_target. Decide",
    "from the complete intent and intended result, never from keywords, paths, or tools.",
  ].join(" "),
  review_artifact_persistence: [
    "Independently compare the exact artifactPersistence value with the immutable",
    "request and intended result. Required means user-requested, reviewed product bytes",
    "must persist at an admitted target. Transient observations, answer content,",
    "external facts or effect receipts, and internally persisted lifecycle records do",
    "not qualify, independent of route, Task, tool, or storage. Require revision when",
    "product artifact persistence is omitted or added without that authority.",
  ].join(" "),
} as const;
