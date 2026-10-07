//! Opt-in timing probe for instrumented stub E2Es; absent from production builds.
use rusqlite::{
    Connection, StatementStatus,
    trace::{TraceEvent, TraceEventCodes},
};
use std::{cell::RefCell, time::Instant};

#[derive(Default)]
struct Load {
    queries: usize,
    result_rows: usize,
    fullscan_steps: usize,
    vm_steps: usize,
    read_us: u128,
    longest_read_us: u128,
    max_depth: usize,
    reads: Vec<(Instant, i32, i32)>,
}
thread_local! {
    static LOAD: RefCell<Load> = RefCell::new(Load::default());
}

fn trace(event: TraceEvent<'_>) {
    LOAD.with(|load| {
        let mut load = load.borrow_mut();
        match event {
            TraceEvent::Stmt(statement, _)
                if statement.sql().trim_start().starts_with("SELECT") =>
            {
                load.queries += 1;
                load.reads.push((
                    Instant::now(),
                    statement.get_status(StatementStatus::FullscanStep),
                    statement.get_status(StatementStatus::VmStep),
                ));
                load.max_depth = load.max_depth.max(load.reads.len());
            }
            TraceEvent::Row(statement) if statement.sql().trim_start().starts_with("SELECT") => {
                load.result_rows += 1;
            }
            TraceEvent::Profile(statement, _)
                if statement.sql().trim_start().starts_with("SELECT") =>
            {
                let Some((start, scans, steps)) = load.reads.pop() else {
                    return;
                };
                let elapsed = start.elapsed().as_micros();
                if load.reads.is_empty() {
                    load.read_us += elapsed;
                }
                load.longest_read_us = load.longest_read_us.max(elapsed);
                load.fullscan_steps +=
                    usize::try_from(statement.get_status(StatementStatus::FullscanStep) - scans)
                        .unwrap_or_default();
                load.vm_steps +=
                    usize::try_from(statement.get_status(StatementStatus::VmStep) - steps)
                        .unwrap_or_default();
            }
            _ => {}
        }
    });
}

pub(super) fn measure<T>(
    db: &mut Connection,
    phase: &str,
    operation: impl FnOnce(&mut Connection) -> T,
) -> T {
    if std::env::var("BUTLER_E2E_DB_LOAD").as_deref() != Ok("1") {
        return operation(db);
    }
    LOAD.with(|load| *load.borrow_mut() = Load::default());
    db.trace_v2(
        TraceEventCodes::SQLITE_TRACE_STMT
            | TraceEventCodes::SQLITE_TRACE_ROW
            | TraceEventCodes::SQLITE_TRACE_PROFILE,
        Some(trace),
    );
    let start = Instant::now();
    let value = operation(db);
    let lane_us = start.elapsed().as_micros();
    db.trace_v2(TraceEventCodes::empty(), None);
    LOAD.with(|load| {
        let load = load.borrow();
        eprintln!("DB_LOAD phase={phase} queries={} result_rows={} fullscan_steps={} vm_steps={} read_us={} longest_read_us={} lane_us={lane_us} connections=1 autocommit={} max_read_depth={}",
            load.queries, load.result_rows, load.fullscan_steps, load.vm_steps, load.read_us,
            load.longest_read_us, db.is_autocommit(), load.max_depth);
    });
    value
}
