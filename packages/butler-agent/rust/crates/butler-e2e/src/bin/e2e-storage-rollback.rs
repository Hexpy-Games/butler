//! Process boundary for the offline correction/open-failure rollback contract.
use butler_turn::btcc::{CorrectionOutcome, run_startup_correction};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args_os().nth(1).ok_or("database path required")?;
    let path = std::path::Path::new(&path);
    let outcome = run_startup_correction(
        path,
        &tokio_util::sync::CancellationToken::new(),
        |_, _, _| {},
    );
    if !matches!(outcome, CorrectionOutcome::Compacted { swapped: true }) {
        return Err(format!("expected compaction: {outcome:?}").into());
    }
    let findings = std::fs::read(path.with_extension("sqlite.findings"))?;
    if !outcome.rollback(path)? {
        return Err("rollback did not restore original".into());
    }
    if std::fs::read(path.with_extension("sqlite.findings"))? != findings {
        return Err("rollback changed verified logical findings".into());
    }
    Ok(())
}
