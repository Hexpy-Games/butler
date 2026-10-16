//! Admission and barrier failures exercise the production WAL writer loop.
use butler_e2e::e2e::binary::fixture_binary;

fn run(scenario: &str) -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::temp_dir().join(format!("storage-lane-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory)?;
    let output = std::process::Command::new(fixture_binary("e2e-storage-lane")?)
        .arg(scenario)
        .arg(directory.join("app.sqlite"))
        .output()?;
    eprintln!("{}", String::from_utf8_lossy(&output.stderr));
    assert!(
        output.status.success(),
        "scenario {scenario}: {}",
        output.status
    );
    std::fs::remove_dir_all(directory)?;
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
