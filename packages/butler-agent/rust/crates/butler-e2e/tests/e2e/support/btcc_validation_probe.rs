//! Opt-in diagnostics retain the complete owner-scale startup gate afterwards.
use butler_e2e::e2e::HarnessError;
use butler_platform::{process_control::usage, secure_fs, sqlite};
use rusqlite::{OpenFlags, OptionalExtension};
use std::{path::Path, time::Instant};

pub(super) fn run(data: &Path) -> Result<(), HarnessError> {
    if std::env::var("BUTLER_E2E_BTCC_VALIDATION_PROBE").as_deref() != Ok("1") {
        return Ok(());
    }
    // Diagnostic scans never qualify startup. Compare complete validation on
    // the same full database, then run the original production readiness gate.
    for (mapped, cache_kib, no_cache) in [
        (0_i64, 2_000, false),
        (8_589_934_592, 2_000, false),
        (0, 65_536, false),
        (8_589_934_592, 65_536, false),
        (2_147_483_648, 65_536, false),
        (0, 262_144, false),
        (0, 524_288, false),
        (8_589_934_592, 2_000, true),
        (8_589_934_592, 65_536, true),
        (0, 65_536, false),
    ] {
        probe(data, mapped, cache_kib, no_cache)?;
    }
    Ok(())
}

fn probe(data: &Path, mapped: i64, cache_kib: i64, no_cache: bool) -> Result<(), HarnessError> {
    let file = std::fs::File::open(data.join("agent-runtime/btcc.sqlite"))?;
    let policy = FixtureCache::new(file, no_cache)?;
    let discarded =
        if let Some(result) = butler_platform::secure_fs::discard_cached_pages(&policy.file) {
            result?;
            true
        } else {
            false
        };
    let db = sqlite::open_with_flags(
        data.join("agent-runtime/btcc.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    db.pragma_update(None, "mmap_size", mapped)?;
    db.pragma_update(None, "cache_size", -cache_kib)?;
    let before = usage::sample(std::process::id())?;
    let start = Instant::now();
    eprintln!(
        "BTCC-VALIDATION-PROBE mapped={mapped} cache_kib={cache_kib} no_cache={no_cache} policy_supported={} cold_advice={discarded} phase=begin io={before:?}",
        policy.changed
    );
    let (send, receive) = std::sync::mpsc::channel();
    let monitor = std::thread::spawn(move || {
        while matches!(
            receive.recv_timeout(std::time::Duration::from_secs(5)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ) {
            eprintln!(
                "BTCC-VALIDATION-PROBE mapped={mapped} cache_kib={cache_kib} no_cache={no_cache} phase=reading elapsed_ms={} io={:?}",
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
        "BTCC-VALIDATION-PROBE mapped={mapped} cache_kib={cache_kib} no_cache={no_cache} phase=complete elapsed_ms={} io={:?}",
        start.elapsed().as_millis(),
        usage::sample(std::process::id())?
    );
    drop(db);
    policy.restore()?;
    Ok(())
}

struct FixtureCache {
    file: std::fs::File,
    changed: bool,
}

impl FixtureCache {
    fn new(file: std::fs::File, no_cache: bool) -> Result<Self, HarnessError> {
        let mut policy = Self {
            file,
            changed: false,
        };
        if no_cache && let Some(result) = secure_fs::fixture_file_cache(&policy.file, false) {
            result?;
            policy.changed = true;
        }
        Ok(policy)
    }

    fn restore(mut self) -> Result<(), HarnessError> {
        if self.changed
            && let Some(result) = secure_fs::fixture_file_cache(&self.file, true)
        {
            result?;
            self.changed = false;
            eprintln!("BTCC-VALIDATION-PROBE file_cache_restored=true");
        }
        Ok(())
    }
}

impl Drop for FixtureCache {
    fn drop(&mut self) {
        if self.changed {
            let _ = secure_fs::fixture_file_cache(&self.file, true);
        }
    }
}
