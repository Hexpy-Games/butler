//! Opt-in diagnostics retain the complete owner-scale startup gate afterwards.
use butler_e2e::e2e::HarnessError;
use butler_platform::{process_control::usage, sqlite};
use rusqlite::{OpenFlags, OptionalExtension};
use std::{path::Path, time::Instant};

pub(super) fn run(data: &Path) -> Result<(), HarnessError> {
    if std::env::var("BUTLER_E2E_BTCC_VALIDATION_PROBE").as_deref() != Ok("1") {
        return Ok(());
    }
    // Repeat neither a failed gate nor a partial integrity check: compare two
    // reader implementations on the same full database, then run the real gate.
    for mapped in [0_i64, 8_589_934_592] {
        let db = sqlite::open_with_flags(
            data.join("agent-runtime/btcc.sqlite"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        db.pragma_update(None, "mmap_size", mapped)?;
        let before = usage::sample(std::process::id())?;
        let start = Instant::now();
        eprintln!("BTCC-VALIDATION-PROBE mapped={mapped} phase=begin io={before:?}");
        let (send, receive) = std::sync::mpsc::channel();
        let monitor = std::thread::spawn(move || {
            while matches!(
                receive.recv_timeout(std::time::Duration::from_secs(5)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                eprintln!(
                    "BTCC-VALIDATION-PROBE mapped={mapped} phase=reading elapsed_ms={} io={:?}",
                    start.elapsed().as_millis(),
                    usage::sample(std::process::id())
                );
            }
        });
        let quick = db.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0));
        let _ = send.send(());
        monitor
            .join()
            .map_err(|_| HarnessError("validation monitor panicked".into()))?;
        assert_eq!(quick?, "ok");
        let foreign: Option<i64> = db
            .query_row("PRAGMA foreign_key_check", [], |row| row.get(0))
            .optional()?;
        assert_eq!(foreign, None);
        eprintln!(
            "BTCC-VALIDATION-PROBE mapped={mapped} phase=complete elapsed_ms={} io={:?}",
            start.elapsed().as_millis(),
            usage::sample(std::process::id())?
        );
    }
    Ok(())
}
