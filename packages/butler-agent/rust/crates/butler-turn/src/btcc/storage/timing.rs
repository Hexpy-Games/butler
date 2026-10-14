//! Opt-in SQLite statement classes and timings; never emit SQL or parameters.
use crate::btcc::agent_loop::command_timing::CommandTiming;
use rusqlite::{
    Connection,
    trace::{TraceEvent, TraceEventCodes},
};
use std::cell::Cell;

pub(super) fn install(connection: &Connection) {
    if std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
        == Some(std::ffi::OsStr::new("1"))
    {
        connection.trace_v2(TraceEventCodes::SQLITE_TRACE_PROFILE, Some(profile));
    }
}

fn profile(event: TraceEvent<'_>) {
    if let TraceEvent::Profile(statement, duration) = event {
        let sql = statement.sql();
        // Only a fixed vocabulary leaves this callback, including on errors.
        let class = match sql
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_uppercase()
            .as_str()
        {
            "SELECT" => "select",
            "INSERT" => "insert",
            "UPDATE" => "update",
            "DELETE" => "delete",
            "BEGIN" => "begin",
            "COMMIT" => "commit",
            "ROLLBACK" => "rollback",
            "PRAGMA" => "pragma",
            _ => "other",
        };
        CommandTiming::report_duration("sqlite_statement", class, duration);
    }
}

// Each BTCC writer owns one connection on its dedicated thread. Keep SQLite's
// configured threshold and PASSIVE mode; like its stock hook, ignore checkpoint
// errors rather than turning an already committed write into a failed operation.
thread_local! {
    static CHECKPOINT_PAGES: Cell<i32> = const { Cell::new(0) };
}

pub(super) fn install_writer(connection: &Connection) -> rusqlite::Result<()> {
    install(connection);
    if std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
        != Some(std::ffi::OsStr::new("1"))
    {
        return Ok(());
    }
    let pages =
        connection.query_row("PRAGMA wal_autocheckpoint", [], |row| row.get::<_, i32>(0))?;
    CHECKPOINT_PAGES.set(pages);
    if pages > 0 {
        connection.wal_hook(Some(checkpoint));
    }
    Ok(())
}

fn checkpoint(wal: &rusqlite::hooks::Wal, pages: i32) -> rusqlite::Result<()> {
    if CHECKPOINT_PAGES.get() > 0 && pages >= CHECKPOINT_PAGES.get() {
        let timing = CommandTiming::new("sqlite_checkpoint");
        let result = wal.checkpoint();
        timing.mark(if result.is_ok() {
            "passive_finished"
        } else {
            "passive_failed"
        });
    }
    Ok(())
}
