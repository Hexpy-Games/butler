//! Native watcher failure recovery and concurrent admission regressions.
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

#[test]
fn ledger_continuous_writer_admissions_are_exact() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-CHURN")?;
    fs::write(f.root.join("public"), b"complete")?;
    fs::write(f.root.join(".env"), b"private")?;
    admit(&f)?;
    let stop = Arc::new(AtomicBool::new(false));
    let writer_stop = stop.clone();
    let root = f.root.clone();
    let writer = std::thread::spawn(move || -> std::io::Result<usize> {
        let mut count = 0;
        while !writer_stop.load(Ordering::Acquire) {
            fs::write(root.join(format!("churn-{count}")), b"complete")?;
            count += 1;
        }
        Ok(count)
    });
    // Always stop/join the writer, including when an assertion panics.
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || -> Result<(), HarnessError> {
            for index in 0..20 {
                if index == 10 {
                    Ledger::age(&f.root)?;
                }
                admit(&f)?;
                assert_eq!(Ledger::aliases(&f.root)?, Vec::<Vec<PathBuf>>::new());
                assert_eq!(
                    command_sandbox::discover_project_secrets(&f.root)?,
                    vec![f.root.join(".env")]
                );
                fs::hard_link(f.root.join("public"), f.root.join(".env-alias"))?;
                refused(&f, 1);
                fs::remove_file(f.root.join(".env-alias"))?;
            }
            Ok(())
        },
    ));
    stop.store(true, Ordering::Release);
    let count = writer.join().unwrap()?;
    result.unwrap()?;
    assert!(count > 0);
    admit(&f)?;
    eprintln!("WINDOWS-LEDGER continuous_writer_files={count} admissions=20 exact=true");
    f.finish();
    Ok(())
}

#[test]
fn ledger_native_overflow_and_caps_rebuild_exactly() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    for (kind, files) in [
        ("native-overflow", 2048),
        ("completions", 65),
        ("changes", 100_001),
    ] {
        let f = Fixture::new(&format!("WIN-LEDGER-{kind}"))?;
        fs::write(f.root.join("public"), b"complete")?;
        admit(&f)?;
        Ledger::exercise(&f.root, kind)?;
        fs::hard_link(f.root.join("public"), f.root.join(".env"))?;
        let error = Ledger::admit(&f.root, &[]).unwrap_err();
        assert!(
            error.to_string().contains("ledger notification overflow"),
            "{kind}: {error}"
        );
        refused(&f, 1);
        assert_eq!(Ledger::verified_files(&f.root)?, files + 2);
        eprintln!(
            "WINDOWS-LEDGER recovery={kind} scanned_files={} exact=true",
            files + 2
        );
        assert_eq!(
            command_sandbox::discover_project_secrets(&f.root)?,
            vec![f.root.join(".env")]
        );
        fs::remove_file(f.root.join(".env"))?;
        admit(&f)?;
        assert_eq!(Ledger::aliases(&f.root)?, Vec::<Vec<PathBuf>>::new());
        assert_eq!(fs::read(f.root.join("public"))?, b"complete");
        f.finish();
    }
    Ok(())
}

#[test]
fn ledger_lost_journal_rebuilds_and_secrets_do_not_wait() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-JOURNAL")?;
    fs::write(f.root.join("public"), b"complete")?;
    admit(&f)?;
    Ledger::pause_verify_commit(&f.root, true)?;
    let root = f.root.clone();
    let verifier = std::thread::spawn(move || Ledger::force_verify(&root));
    let deadline = Instant::now() + Duration::from_secs(2);
    while !Ledger::verify_commit_paused(&f.root)? {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    fs::hard_link(f.root.join("public"), f.root.join(".env"))?;
    // The verifier is blocked; this must return the old inventory plus its delta.
    assert_eq!(
        command_sandbox::discover_project_secrets(&f.root)?,
        vec![f.root.join(".env")]
    );
    Ledger::exercise(&f.root, "lose-journal")?;
    Ledger::pause_verify_commit(&f.root, false)?;
    let error = verifier.join().unwrap().unwrap_err();
    assert!(
        error.to_string().contains("ledger verify journal missing"),
        "{error}"
    );
    refused(&f, 1);
    fs::remove_file(f.root.join(".env"))?;
    admit(&f)?;
    f.finish();
    Ok(())
}

#[test]
fn ledger_verify_age_includes_time_before_commit() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-SCAN-AGE")?;
    admit(&f)?;
    Ledger::pause_verify_commit(&f.root, true)?;
    let root = f.root.clone();
    let verifier = std::thread::spawn(move || Ledger::force_verify(&root));
    let deadline = Instant::now() + Duration::from_secs(2);
    while !Ledger::verify_commit_paused(&f.root)? {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    std::thread::sleep(Duration::from_millis(150));
    Ledger::pause_verify_commit(&f.root, false)?;
    verifier.join().unwrap()?;
    let (age, verifying) = Ledger::snapshot(&f.root)?;
    assert!(age >= 150 && !verifying, "age={age}, verifying={verifying}");
    admit(&f)?;
    f.finish();
    Ok(())
}

#[test]
fn ledger_root_changes_wait_for_background_commit() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-ROOTS-RACE")?;
    admit(&f)?;
    let scratch = f.setup.sandbox.home.join("scratch");
    fs::create_dir(&scratch)?;
    fs::write(scratch.join("public"), b"complete")?;
    fs::hard_link(scratch.join("public"), f.setup.sandbox.home.join("outside"))?;
    Ledger::pause_verify_commit(&f.root, true)?;
    Ledger::age(&f.root)?;
    command_sandbox::sweep_new_secrets(&f.root, &Default::default(), &f.setup.sandbox.data)?;
    let deadline = Instant::now() + Duration::from_secs(2);
    while !Ledger::verify_commit_paused(&f.root)? {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let root = f.root.clone();
    let waiter = std::thread::spawn(move || {
        tx.send(Ledger::admit_with_roots(&root, &[scratch]))
            .unwrap();
    });
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
    Ledger::pause_verify_commit(&f.root, false)?;
    let error = rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap_err();
    assert!(
        error.to_string().contains("project_write_link_aliases"),
        "{error}"
    );
    waiter.join().unwrap();
    refused(&f, 1);
    f.finish();
    Ok(())
}

#[test]
fn ledger_quarantine_result_survives_rebuild_start_failure() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-QUARANTINE")?;
    let scratch = f.setup.sandbox.home.join("scratch");
    fs::create_dir(&scratch)?;
    Ledger::admit_with_roots(&f.root, std::slice::from_ref(&scratch))?;
    fs::remove_dir(&scratch)?;
    let secret = f.root.join(".env");
    fs::write(&secret, b"private")?;
    assert_eq!(
        command_sandbox::sweep_new_secrets(&f.root, &Default::default(), &f.setup.sandbox.data)?,
        vec![secret.clone()]
    );
    assert!(!secret.exists());
    assert!(Ledger::admit(&f.root, &[]).is_err());
    fs::create_dir(&scratch)?;
    admit(&f)?;
    assert_eq!(
        command_sandbox::discover_project_secrets(&f.root)?,
        Vec::<PathBuf>::new()
    );
    f.finish();
    Ok(())
}

#[test]
fn ledger_aged_timeout_only_defers_that_admission() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-AGED-TIMEOUT")?;
    fs::write(f.root.join("public"), b"complete")?;
    admit(&f)?;
    fs::hard_link(f.root.join("public"), f.setup.sandbox.home.join("outside"))?;
    Ledger::age(&f.root)?;
    Ledger::pause_verify(&f.root, true)?;
    let error = Ledger::admit(&f.root, &[]).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock);
    assert!(Ledger::snapshot(&f.root)?.1);
    assert_eq!(
        command_sandbox::discover_project_secrets(&f.root)?,
        Vec::<PathBuf>::new()
    );
    Ledger::pause_verify(&f.root, false)?;
    refused(&f, 1);
    f.finish();
    Ok(())
}

#[test]
fn ledger_watcher_loss_during_verify_loses_journal_and_rebuilds() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-LOST-JOURNAL")?;
    admit(&f)?;
    Ledger::pause_verify_commit(&f.root, true)?;
    let root = f.root.clone();
    let verifier = std::thread::spawn(move || Ledger::force_verify(&root));
    let deadline = Instant::now() + Duration::from_secs(2);
    while !Ledger::verify_commit_paused(&f.root)? {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    }
    fs::rename(&f.root, f.root.with_file_name("old-project"))?;
    fs::create_dir(&f.root)?;
    fs::write(f.root.join("public"), b"replacement")?;
    fs::hard_link(f.root.join("public"), f.root.join(".env"))?;
    let error = command_sandbox::discover_project_secrets(&f.root).unwrap_err();
    assert!(
        error.to_string().contains("ledger verify journal lost"),
        "{error}"
    );
    Ledger::pause_verify_commit(&f.root, false)?;
    assert!(verifier.join().unwrap().is_err());
    refused(&f, 1);
    assert_eq!(Ledger::verified_files(&f.root)?, 2);
    assert_eq!(
        command_sandbox::discover_project_secrets(&f.root)?,
        vec![f.root.join(".env")]
    );
    fs::remove_file(f.root.join(".env"))?;
    admit(&f)?;
    assert_eq!(fs::read(f.root.join("public"))?, b"replacement");
    f.finish();
    Ok(())
}
