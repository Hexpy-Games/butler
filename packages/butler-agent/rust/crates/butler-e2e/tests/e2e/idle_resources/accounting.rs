//! Counter assertions shared with a real-write child fixture.
use butler_e2e::e2e::HarnessError;
use butler_platform::process_control::usage::{self, ProcessUsage};

pub(super) fn assert_no_writes(before: &ProcessUsage, after: &ProcessUsage) {
    // wchar also counts socket and eventfd writes, such as the live-event
    // heartbeat to a connected App, so idle disk writes are judged by
    // write_bytes together with the file and database watches.
    assert_eq!(
        after.write_bytes, before.write_bytes,
        "physical writes during idle"
    );
}

#[test]
fn idle_write_accounting_rejects_real_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        usage::sample(std::process::id())?.is_some_and(|sample| sample.write_chars.is_some()),
        "buffered write counters unavailable"
    );
    if let Ok(mode) = std::env::var("BUTLER_E2E_IDLE_WRITE_FIXTURE") {
        return fixture(&mode);
    }
    for mode in ["probe", "idle"] {
        let root = std::env::temp_dir().join(format!("idle-writes-{}", uuid::Uuid::new_v4()));
        let home = root.join("home");
        let data = root.join("data");
        std::fs::create_dir_all(&home)?;
        std::fs::create_dir_all(&data)?;
        let output = std::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "idle_resources::accounting::idle_write_accounting_rejects_real_writes",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("HOME", &home)
            .env("BUTLER_DATA", &data)
            .env("BUTLER_E2E_IDLE_WRITE_FIXTURE", mode)
            .output()?;
        std::fs::remove_dir_all(root)?;
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.success(), mode == "probe", "{stderr}");
        if mode == "idle" {
            assert!(stderr.contains("physical writes during idle"), "{stderr}");
            eprintln!("PERF-IDLE injected write rejected: {stderr}");
        }
    }
    Ok(())
}

fn fixture(mode: &str) -> Result<(), HarnessError> {
    let data = std::path::PathBuf::from(std::env::var_os("BUTLER_DATA").unwrap());
    let pid = std::process::id();
    let before_probe = usage::sample(pid)?.unwrap();
    let payload = b"completed pre-window write";
    std::fs::write(data.join("pre-window-write"), payload)?;
    let before = usage::sample(pid)?.unwrap();
    assert!(
        before.write_bytes > before_probe.write_bytes,
        "write_bytes must count a completed buffered write"
    );
    if mode == "idle" {
        std::fs::write(data.join("idle-write"), b"unexpected idle write")?;
    }
    let after = usage::sample(pid)?.unwrap();
    assert_no_writes(&before, &after);
    Ok(())
}
