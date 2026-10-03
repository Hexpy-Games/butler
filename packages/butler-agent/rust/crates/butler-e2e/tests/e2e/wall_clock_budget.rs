//! The same over-budget measurement records in shared runs and fails in perf.
use butler_e2e::e2e::HarnessError;
use std::process::Command;
use std::time::Duration;

#[test]
fn wall_clock_budget_obeys_the_selected_tier() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    if std::env::var_os("BUTLER_E2E_BUDGET_FIXTURE").is_some() {
        let evaluations = std::cell::Cell::new(0);
        let measured = || {
            evaluations.set(evaluations.get() + 1);
            Duration::ZERO
        };
        butler_e2e::assert_wall_clock_budget!(measured(), measured(), "tier fixture");
        assert_eq!(evaluations.get(), 2);
        return Ok(());
    }
    for enforce in [None, Some("0"), Some("1")] {
        let root = std::env::temp_dir().join(format!(
            "budget-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let home = root.join("home");
        let data = root.join("data");
        std::fs::create_dir_all(&home)?;
        std::fs::create_dir_all(&data)?;
        let mut command = Command::new(std::env::current_exe()?);
        command
            .args([
                "--exact",
                "wall_clock_budget::wall_clock_budget_obeys_the_selected_tier",
                "--nocapture",
            ])
            .env("HOME", &home)
            .env("BUTLER_DATA", &data)
            .env("BUTLER_E2E_BUDGET_FIXTURE", "1")
            .env_remove("BUTLER_E2E_PERF");
        if let Some(value) = enforce {
            command.env("BUTLER_E2E_PERF", value);
        }
        let output = command.output()?;
        std::fs::remove_dir_all(root)?;
        let strict = enforce == Some("1");
        assert_eq!(output.status.success(), !strict);
        assert!(String::from_utf8_lossy(&output.stderr).contains(&format!("enforced={strict}")));
    }
    Ok(())
}
