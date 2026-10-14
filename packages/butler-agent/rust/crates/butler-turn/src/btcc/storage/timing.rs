//! Opt-in SQLite statement classes and timings; never emit SQL or parameters.
use crate::btcc::agent_loop::command_timing::CommandTiming;
use rusqlite::{
    Connection,
    trace::{TraceEvent, TraceEventCodes},
};

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
