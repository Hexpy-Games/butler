//! LIVE-tier gating, skip reporting and the spend guard.

use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};

use super::config::{LiveProvider, Tier, live_max_turns, nonempty};
use super::{HarnessError, harness_error};

static LIVE_TURNS: AtomicU32 = AtomicU32::new(0);

/// Returns the live provider when `scenario` should run against it.
///
/// - tier `stub`: `SKIPPED (tier)`.
/// - tier `all` without credentials: `SKIPPED (no credentials: <provider>)`.
/// - tier `live` without credentials: error (a live result was requested).
pub fn gate(scenario: &str) -> Result<Option<LiveProvider>, HarnessError> {
    let tier = Tier::from_env();
    if !tier.runs_live() {
        report(scenario, "SKIPPED (tier: stub)");
        return Ok(None);
    }
    let provider = LiveProvider::from_env();
    if provider.credential.is_none() {
        let reason = format!("no credentials: {}", provider.provider);
        if tier == Tier::Live {
            report(scenario, &format!("FAILED ({reason})"));
            return Err(harness_error(format!(
                "BUTLER_E2E_TIER=live but {reason}; see crates/butler-e2e/README.md"
            )));
        }
        report(scenario, &format!("SKIPPED ({reason})"));
        return Ok(None);
    }
    Ok(Some(provider))
}

/// Counts one live model turn against `BUTLER_E2E_LIVE_MAX_TURNS`.
pub fn spend_turn() -> Result<(), HarnessError> {
    let used = LIVE_TURNS.fetch_add(1, Ordering::SeqCst) + 1;
    if used > live_max_turns() {
        return Err(harness_error(format!(
            "live spend guard: more than {} turns (BUTLER_E2E_LIVE_MAX_TURNS)",
            live_max_turns()
        )));
    }
    Ok(())
}

/// Prints a visible status line and appends it to `BUTLER_E2E_REPORT`.
pub fn report(scenario: &str, status: &str) {
    let line = format!("{scenario}: {status}");
    eprintln!("{line}");
    println!("{line}");
    if let Some(path) = nonempty("BUTLER_E2E_REPORT")
        && let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}
