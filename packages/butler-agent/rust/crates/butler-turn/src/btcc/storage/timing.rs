//! Opt-in SQLite statement classes and timings; never emit SQL or parameters.
use crate::btcc::agent_loop::command_timing::CommandTiming;
use rusqlite::{
    Connection,
    trace::{TraceEvent, TraceEventCodes},
};
use std::cell::Cell;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(super) fn install(connection: &Connection) {
    if CommandTiming::enabled() {
        connection.trace_v2(TraceEventCodes::SQLITE_TRACE_PROFILE, Some(profile));
    }
}

fn profile(event: TraceEvent<'_>) {
    if let TraceEvent::Profile(statement, duration) = event {
        let commit = COMMIT_STARTED.take().map(|started| started.elapsed());
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
        if let Some(commit) = commit {
            CommandTiming::report_duration("sqlite_commit", "hook_to_profile", commit);
        }
        if duration.as_millis() >= 20 {
            butler_platform::stdio::diagnostic_line(format_args!(
                "command_sql_work class={class} utc_us={} vm_steps_total={} fullscan_steps_total={} sorts_total={} mem_bytes={}",
                utc_us(),
                statement.get_status(rusqlite::StatementStatus::VmStep),
                statement.get_status(rusqlite::StatementStatus::FullscanStep),
                statement.get_status(rusqlite::StatementStatus::Sort),
                statement.get_status(rusqlite::StatementStatus::MemUsed),
            ));
        }
    }
}

thread_local! {
    static COMMIT_STARTED: Cell<Option<Instant>> = const { Cell::new(None) };
    static LAST_WAL_PAGES: Cell<i32> = const { Cell::new(0) };
}

pub(super) fn install_writer(connection: &Connection) {
    install(connection);
    if !CommandTiming::enabled() {
        return;
    }
    connection.commit_hook(Some(|| {
        COMMIT_STARTED.set(Some(Instant::now()));
        false
    }));
}

pub(super) fn wal_committed(pages: i32) {
    if !CommandTiming::enabled() {
        return;
    }
    let prior = LAST_WAL_PAGES.replace(pages);
    if pages < prior {
        butler_platform::stdio::diagnostic_line(format_args!(
            "command_wal_timing event=restarted utc_us={} pages={pages} prior_pages={prior}",
            utc_us()
        ));
    }
}

fn utc_us() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
}
