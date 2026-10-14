//! Opt-in SQLite statement classes and timings; never emit SQL or parameters.
use crate::btcc::agent_loop::command_timing::CommandTiming;
use rusqlite::{
    Connection,
    trace::{TraceEvent, TraceEventCodes},
};
use std::cell::Cell;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub(super) fn install(connection: &Connection) {
    if std::env::var_os("BUTLER_DEBUG_COMMAND_TIMINGS").as_deref()
        == Some(std::ffi::OsStr::new("1"))
    {
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
            eprintln!(
                "command_sql_work class={class} utc_us={} vm_steps_total={} fullscan_steps_total={} sorts_total={} mem_bytes={}",
                utc_us(),
                statement.get_status(rusqlite::StatementStatus::VmStep),
                statement.get_status(rusqlite::StatementStatus::FullscanStep),
                statement.get_status(rusqlite::StatementStatus::Sort),
                statement.get_status(rusqlite::StatementStatus::MemUsed),
            );
        }
    }
}

// Each BTCC writer owns one connection on its dedicated thread. Keep SQLite's
// configured threshold and PASSIVE mode; like its stock hook, ignore checkpoint
// errors rather than turning an already committed write into a failed operation.
thread_local! {
    static CHECKPOINT_PAGES: Cell<i32> = const { Cell::new(0) };
    static COMMIT_STARTED: Cell<Option<Instant>> = const { Cell::new(None) };
    static LAST_WAL_PAGES: Cell<i32> = const { Cell::new(0) };
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
    connection.commit_hook(Some(|| {
        COMMIT_STARTED.set(Some(Instant::now()));
        false
    }));
    if pages > 0 {
        connection.wal_hook(Some(checkpoint));
    }
    Ok(())
}

fn checkpoint(wal: &rusqlite::hooks::Wal, pages: i32) -> rusqlite::Result<()> {
    let prior = LAST_WAL_PAGES.replace(pages);
    if pages < prior {
        eprintln!(
            "command_wal_timing event=restarted utc_us={} pages={pages} prior_pages={prior}",
            utc_us()
        );
    }
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

fn utc_us() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
}
