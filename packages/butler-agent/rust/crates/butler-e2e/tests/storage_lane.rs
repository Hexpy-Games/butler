//! Admission and barrier failures must preserve earlier lane completions.
use butler_e2e::e2e::binary::fixture_binary;

#[test]
fn earlier_completions_survive_later_admission_and_commit_failures()
-> Result<(), Box<dyn std::error::Error>> {
    butler_e2e::gate!();
    let output = std::process::Command::new(fixture_binary("e2e-storage-lane")?).output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
