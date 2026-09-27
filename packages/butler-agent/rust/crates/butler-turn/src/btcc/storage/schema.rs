pub(super) mod authority;
pub(super) mod core;
pub(super) mod effects;
pub(super) mod legacy;
pub(super) mod subsession;
pub(super) mod work;

use rusqlite::Connection;

pub(super) fn create_current(connection: &Connection) -> rusqlite::Result<()> {
    for schema in [
        core::CORE_SCHEMA,
        work::WORK_SCHEMA,
        effects::EFFECTS_SCHEMA,
        authority::AUTHORITY_SCHEMA,
        subsession::SUBSESSION_SCHEMA,
        legacy::LEGACY_SCHEMA,
    ] {
        connection.execute_batch(schema)?;
    }
    Ok(())
}
