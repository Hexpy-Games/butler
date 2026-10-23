//! Legacy presence queries must remain independent of the writer lane.
use butler_e2e::e2e::{HarnessError, binary::fixture_binary};

// test-category: race
#[test]
fn legacy_queue_presence_reads_while_writer_is_held() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let output = std::process::Command::new(fixture_binary("e2e-queue-presence")?).output()?;
    eprintln!("{}", String::from_utf8_lossy(&output.stdout));
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
