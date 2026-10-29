use std::sync::{Barrier, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{fs, path::Path};

#[test]
fn concurrent_harness_processes_share_one_port_lease_directory() -> Result<(), super::HarnessError>
{
    butler_e2e::gate!();
    const CALLERS: usize = 32;
    const ROUNDS: usize = 256;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let namespaces: Vec<_> = (0..ROUNDS)
        .map(|round| format!("butler-lock-race-{}-{nonce}-{round}", std::process::id()))
        .collect();
    let barrier = Barrier::new(CALLERS + 1);
    let failures = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..CALLERS {
            scope.spawn(|| {
                for (round, namespace) in namespaces.iter().enumerate() {
                    barrier.wait();
                    if let Err(error) = butler_platform::shared_locks::open(namespace, "x.lock") {
                        failures.lock().unwrap().push((round, error.to_string()));
                    }
                    barrier.wait();
                }
            });
        }
        for namespace in &namespaces {
            barrier.wait();
            barrier.wait();
            // `open` rejects a directory without its shared mode, so success is
            // the mode check. Remove the namespace from whichever root holds it.
            for root in [Path::new("/tmp"), &std::env::temp_dir()] {
                let _ = fs::remove_dir_all(root.join(namespace));
            }
        }
    });
    let failures = failures.into_inner().unwrap();
    let failed_rounds = failures
        .iter()
        .map(|(round, _)| *round)
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    eprintln!(
        "shared lock directory race: {}/{} callers failed; {failed_rounds}/{ROUNDS} namespaces affected",
        failures.len(),
        CALLERS * ROUNDS,
    );
    assert!(failures.is_empty(), "directory failures: {failures:?}");
    Ok(())
}
