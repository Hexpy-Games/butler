#![allow(clippy::unwrap_used, reason = "test assertions")]

use super::*;
use std::sync::{Barrier, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

// test-category: race
#[test]
fn concurrent_directory_creation_publishes_complete_permissions() {
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
    let mut bad_modes = Vec::new();
    std::thread::scope(|scope| {
        for _ in 0..CALLERS {
            scope.spawn(|| {
                for (round, namespace) in namespaces.iter().enumerate() {
                    barrier.wait();
                    if let Err(error) = directory(namespace) {
                        failures.lock().unwrap().push((round, error.to_string()));
                    }
                    barrier.wait();
                }
            });
        }
        for namespace in &namespaces {
            barrier.wait();
            barrier.wait();
            let path = Path::new("/tmp").join(namespace);
            let mode = fs::metadata(&path).map(|metadata| metadata.mode() & 0o7777);
            if !matches!(mode, Ok(0o1777)) {
                bad_modes.push((namespace, mode));
            }
            fs::remove_dir(path).unwrap();
        }
    });
    let failures = failures.into_inner().unwrap();
    let failed_rounds = failures
        .iter()
        .map(|(round, _)| *round)
        .collect::<std::collections::BTreeSet<_>>()
        .len();
    eprintln!(
        "directory race: {}/{} callers failed; {failed_rounds}/{ROUNDS} namespaces affected",
        failures.len(),
        CALLERS * ROUNDS,
    );
    assert!(bad_modes.is_empty(), "incorrect final modes: {bad_modes:?}");
    assert!(failures.is_empty(), "directory failures: {failures:?}");
}
