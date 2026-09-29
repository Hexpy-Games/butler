//! Dev-only end-to-end harness for Butler.
//!
//! The system under test is the real `butler-agent` executable. The harness
//! starts it with an isolated data dir and free ports, and drives it only
//! through its public surface: gateway HTTP, the CLI, process signals and the
//! data dir on disk. Model traffic goes to a record/replay provider that serves
//! sanitized recordings of real provider traffic (see `e2e::stub`).
//!
//! Scenarios live in `tests/`; the catalog and rules are in `README.md`.

pub mod e2e;

/// Opt-in gate: E2E scenarios run only when `BUTLER_E2E_TIER` is set
/// (`stub`, `live` or `all`). A plain `cargo test --workspace` (unit-test
/// CI) therefore does not run the stub tier a second time; it reports each
/// scenario as skipped and returns. The `e2e` workflow sets the tier.
#[macro_export]
macro_rules! gate {
    () => {
        if !$crate::e2e::config::tier_selected() {
            return Ok(());
        }
    };
}

/// Ends a scenario that needs a capability this host lacks, and says so: the
/// run prints `butler-e2e: SKIPPED (<reason>)` (visible with `--nocapture`),
/// so a skipped scenario is never mistaken for a passed one.
#[macro_export]
macro_rules! skip_unless {
    ($capability:expr, $reason:expr) => {
        if !$capability {
            eprintln!("butler-e2e: SKIPPED ({})", $reason);
            return Ok(());
        }
    };
}
