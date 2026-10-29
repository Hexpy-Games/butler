//! Admission and barrier failures exercise the production WAL writer loop.
use butler_e2e::e2e::binary::fixture_binary;

struct Directory(std::path::PathBuf);
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run(scenario: &str) -> Result<(), Box<dyn std::error::Error>> {
    let directory =
        Directory(std::env::temp_dir().join(format!("storage-lane-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir(&directory.0)?;
    let output = std::process::Command::new(fixture_binary("e2e-storage-lane")?)
        .arg(scenario)
        .arg(directory.0.join("app.sqlite"))
        .env("BUTLER_DEBUG_COMMAND_TIMINGS", "1")
        .output()?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    eprintln!("{stderr}");
    assert!(
        output.status.success(),
        "scenario {scenario}: {}",
        output.status
    );
    if scenario == "barrier" {
        assert_barrier_sync(&stderr)?;
    }
    if scenario == "sync" {
        assert_sync_retry(&stderr)?;
    }
    Ok(())
}

fn assert_barrier_sync(stderr: &str) -> Result<(), Box<dyn std::error::Error>> {
    let (_, after_write) = stderr
        .split_once("writing barrier transaction committed\n")
        .ok_or("missing writing barrier marker")?;
    let (before_next, _) = after_write
        .split_once("writing barrier completion observed\n")
        .ok_or("missing barrier completion marker")?;
    let synced = before_next.lines().position(|line| {
        line.contains("phase=app_sqlite_wal_sync ") && line.contains("event=synced ")
    });
    let completed = before_next.lines().position(|line| {
        line.contains("phase=app_sqlite_operation ") && line.contains("event=committed ")
    });
    assert!(
        matches!((synced, completed), (Some(sync), Some(complete)) if sync < complete),
        "writing barrier must sync before completing: {before_next}"
    );
    Ok(())
}

fn assert_sync_retry(stderr: &str) -> Result<(), Box<dyn std::error::Error>> {
    let (before_failure, after_failure) = stderr
        .split_once("WAL sync failure completion observed\n")
        .ok_or("missing WAL sync failure completion marker")?;
    assert!(
        before_failure.contains("committed; WAL index sync failed"),
        "missing committed WAL-index sync failure diagnostic"
    );
    assert!(
        after_failure.lines().any(|line| {
            line.contains("phase=app_sqlite_wal_sync ") && line.contains("event=synced ")
        }),
        "missing successful WAL-index sync after the failed completion: {after_failure}"
    );
    Ok(())
}

#[test]
fn earlier_completions_survive_failed_begin() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    run("begin")
}

#[test]
fn barrier_completions_survive_later_commit_failure() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    run("barrier")
}

#[test]
fn failed_commit_rolls_back_and_writer_commits_next_batch() -> Result<(), Box<dyn std::error::Error>>
{
    butler_e2e::gate!();
    run("commit")
}

#[test]
fn failed_wal_sync_after_commit_keeps_writer() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    if !butler_platform::sqlite::wal_index_sync_supported() {
        eprintln!("SKIPPED: this platform has no WAL-index sync implementation");
        return Ok(());
    }
    run("sync")
}

// test-category: race
#[test]
fn cleanup_acknowledgment_preserves_replaced_records() -> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    run("cleanup")
}
