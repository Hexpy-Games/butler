use super::Entry;

pub(super) const ROUTES: &[Entry] = &[
    route!(
        "cognition.memory.status",
        "butler cognition memory status",
        "Read native memory health.",
        "advanced"
    ),
    route!(
        "cognition.memory.metadata.check",
        "butler cognition memory metadata check",
        "Check legacy metadata references.",
        "advanced"
    ),
    route!(
        "cognition.memory.recall",
        "butler cognition memory recall QUERY",
        "Search the source-compatible command-local memory corpus.",
        "advanced"
    ),
    route!(
        "cognition.memory.ingest",
        "butler cognition memory ingest --session SESSION_ID",
        "Import a reviewed transcript through the legacy memory owners.",
        "advanced"
    ),
    route!(
        "cognition.memory.project.inspect",
        "butler cognition memory project inspect PROJECT_ID",
        "Inspect a project capsule.",
        "advanced"
    ),
    route!(
        "cognition.memory.metadata.inspect",
        "butler cognition memory metadata inspect CHUNK_ID",
        "Inspect a legacy memory chunk and references.",
        "advanced"
    ),
    route!(
        "cognition.memory.metadata.repair-links",
        "butler cognition memory metadata repair-links --yes",
        "Repair reviewed legacy metadata links.",
        "advanced"
    ),
    route!(
        "cognition.memory.recovery.plan",
        "butler cognition memory recovery plan PROJECT_ID",
        "Plan continuity recovery without applying it.",
        "advanced"
    ),
    route!(
        "cognition.memory.recovery.inspect",
        "butler cognition memory recovery inspect MANIFEST_ID",
        "Inspect a continuity recovery manifest.",
        "advanced"
    ),
    route!(
        "cognition.memory.recovery.approve",
        "butler cognition memory recovery approve MANIFEST_ID all --yes",
        "Approve reviewed recovery candidates.",
        "advanced"
    ),
    route!(
        "cognition.memory.recovery.apply",
        "butler cognition memory recovery apply MANIFEST_ID --yes",
        "Apply an approved recovery manifest.",
        "advanced"
    ),
    route!(
        "cognition.memory.recovery.rollback",
        "butler cognition memory recovery rollback MANIFEST_ID --yes",
        "Roll back an applied recovery manifest.",
        "advanced"
    ),
    route!(
        "cognition.migrate.status",
        "butler cognition migrate --status",
        "Read namespace migration status.",
        "advanced"
    ),
    route!(
        "cognition.migrate.plan",
        "butler cognition migrate --dry-run",
        "Plan namespace migration and conflicts.",
        "advanced"
    ),
    route!(
        "cognition.migrate.apply",
        "butler cognition migrate --apply",
        "Apply a reviewed namespace migration.",
        "advanced"
    ),
    route!(
        "cognition.feedback.list",
        "butler cognition feedback list",
        "List feedback entries.",
        "advanced"
    ),
    route!(
        "cognition.feedback.add",
        "butler cognition feedback add --text TEXT",
        "Record explicit feedback.",
        "advanced"
    ),
    route!(
        "cognition.feedback.show",
        "butler cognition feedback show ID",
        "Read a feedback entry.",
        "advanced"
    ),
    route!(
        "cognition.feedback.resolve",
        "butler cognition feedback resolve ID --status STATUS",
        "Resolve an explicit feedback entry.",
        "advanced"
    ),
    route!(
        "cognition.feedback.clear",
        "butler cognition feedback clear --applied --yes",
        "Clear applied feedback entries.",
        "advanced"
    ),
    route!(
        "cognition.box.list",
        "butler cognition box list",
        "List Box items.",
        "advanced"
    ),
    route!(
        "cognition.box.show",
        "butler cognition box show ID",
        "Read a Box item.",
        "advanced"
    ),
    route!(
        "cognition.box.inspect",
        "butler cognition box inspect ID",
        "Inspect a Box item.",
        "advanced"
    ),
    route!(
        "cognition.box.forget",
        "butler cognition box forget ID --mode MODE --yes",
        "Forget a reviewed Box item.",
        "advanced"
    ),
    route!(
        "cognition.box.rebuild-index",
        "butler cognition box rebuild-index",
        "Rebuild the Box index.",
        "advanced"
    ),
    route!(
        "cognition.know-how.list",
        "butler cognition know-how list",
        "List know-how entries.",
        "advanced"
    ),
    route!(
        "cognition.know-how.show",
        "butler cognition know-how show ID",
        "Read a know-how entry.",
        "advanced"
    ),
    route!(
        "cognition.know-how.disable",
        "butler cognition know-how disable ID --yes",
        "Disable a know-how entry.",
        "advanced"
    ),
    route!(
        "cognition.know-how.retrieve",
        "butler cognition know-how retrieve QUERY",
        "Retrieve applicable know-how.",
        "advanced"
    ),
    route!(
        "cognition.know-how.source-quality",
        "butler cognition know-how source-quality",
        "Read source-quality summaries.",
        "advanced"
    ),
    route!(
        "cognition.know-how.rebuild-index",
        "butler cognition know-how rebuild-index",
        "Rebuild the know-how index.",
        "advanced"
    ),
    route!(
        "cognition.memory.maintain",
        "butler cognition memory maintain",
        "Run native memory maintenance.",
        "advanced"
    ),
    route!(
        "cognition.memory.rebuild.prepare",
        "butler cognition memory rebuild prepare",
        "Prepare a memory generation.",
        "advanced"
    ),
    route!(
        "cognition.memory.rebuild.build",
        "butler cognition memory rebuild build --generation ID",
        "Build a memory generation.",
        "advanced"
    ),
    route!(
        "cognition.memory.rebuild.inspect",
        "butler cognition memory rebuild inspect --generation ID",
        "Inspect a memory generation.",
        "advanced"
    ),
    route!(
        "cognition.memory.rebuild.validate",
        "butler cognition memory rebuild validate --generation ID --acceptance PATH",
        "Validate a memory generation.",
        "advanced"
    ),
    route!(
        "cognition.memory.rebuild.activate",
        "butler cognition memory rebuild activate --generation ID",
        "Activate a validated generation.",
        "advanced"
    ),
    route!(
        "cognition.memory.rebuild.rollback",
        "butler cognition memory rebuild rollback --generation ID",
        "Roll back to a generation.",
        "advanced"
    ),
    route!(
        "cognition.memory.rebuild.retry-failed",
        "butler cognition memory rebuild retry-failed --generation ID",
        "Retry failed generation sources.",
        "advanced"
    ),
    route!(
        "cognition.memory.rebuild.set-extractor",
        "butler cognition memory rebuild set-extractor --generation ID",
        "Set generation extractor configuration.",
        "advanced"
    ),
    route!(
        "cognition.memory.rebuild.repair-inputs",
        "butler cognition memory rebuild repair-inputs --generation ID --input PATH",
        "Repair reviewed generation inputs.",
        "advanced"
    ),
    route!(
        "cognition.memory.rebuild.initialize-empty",
        "butler cognition memory rebuild initialize-empty",
        "Initialize an explicit empty generation.",
        "advanced"
    ),
    route!(
        "cognition.consolidation.status",
        "butler cognition consolidation status",
        "Read native consolidation state.",
        "advanced"
    ),
    route!(
        "cognition.consolidation.run",
        "butler cognition consolidation run --manual",
        "Run a manual consolidation cycle.",
        "advanced"
    ),
];
