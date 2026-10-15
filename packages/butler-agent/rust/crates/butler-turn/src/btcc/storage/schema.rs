pub(super) mod authority;
pub(super) mod core;
pub(super) mod correction;
pub(super) mod effects;
pub(super) mod legacy;
pub(super) mod subsession;
pub(super) mod task_graphs;
pub(super) mod work;

use rusqlite::Connection;

pub(super) fn create_current(connection: &Connection) -> rusqlite::Result<()> {
    // Schema publication is one atomic change. Autocommitting every table and
    // index creates and flushes a rollback journal for each DDL statement.
    let transaction = connection.unchecked_transaction()?;
    let timing = super::super::agent_loop::command_timing::CommandTiming::new("storage_schema");
    for schema in [
        core::CORE_SCHEMA,
        work::WORK_SCHEMA,
        effects::EFFECTS_SCHEMA,
        authority::AUTHORITY_SCHEMA,
        subsession::SUBSESSION_SCHEMA,
        legacy::LEGACY_SCHEMA,
    ] {
        transaction.execute_batch(schema)?;
    }
    timing.mark("created");
    transaction.commit()?;
    timing.mark("committed");
    Ok(())
}
