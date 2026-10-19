//! Stub-tier native ledger admission, mutation and bounded-window evidence.
use super::*;
use butler_platform::command_sandbox::WindowsLedger as Ledger;
use std::{
    fs,
    time::{Duration, Instant},
};

fn admit(f: &Fixture) -> std::io::Result<()> {
    Ledger::admit(
        &f.root,
        &command_sandbox::discover_project_secrets(&f.root)?,
    )
}
fn refused(f: &Fixture, groups: usize) {
    let error = admit(f).unwrap_err();
    assert!(
        error.to_string().contains("project_write_link_aliases"),
        "{error}"
    );
    assert_eq!(Ledger::aliases(&f.root).unwrap().len(), groups);
}
#[test]
fn ledger_replaced_root_fails_closed_and_rebuilds() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-ROOT")?;
    fs::write(f.root.join("public.txt"), b"complete")?;
    admit(&f)?;
    let previous = f.root.with_file_name("previous-project");
    fs::rename(&f.root, &previous)?;
    fs::create_dir(&f.root)?;
    fs::write(f.root.join("public.txt"), b"replacement")?;
    fs::hard_link(f.root.join("public.txt"), f.root.join(".env"))?;
    let error = Ledger::admit(&f.root, &[]).unwrap_err();
    assert!(
        error.to_string().contains("ledger watched root replaced"),
        "{error}"
    );
    refused(&f, 1);
    fs::remove_file(f.root.join(".env"))?;
    admit(&f)?;
    assert_eq!(fs::read(f.root.join("public.txt"))?, b"replacement");
    f.finish();
    Ok(())
}
#[test]
fn ledger_inside_secret_aliases_and_removal() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-INSIDE")?;
    fs::write(f.root.join("public.txt"), "complete")?;
    fs::create_dir(f.root.join(".git"))?;
    fs::create_dir(f.root.join(".env.directory"))?;
    admit(&f)?;
    for name in [".env", ".git/x", ".env.directory/x"] {
        let alias = f.root.join(name);
        fs::hard_link(f.root.join("public.txt"), &alias)?;
        // No settling sleep: the very next admission must see an inside alias.
        refused(&f, 1);
        fs::remove_file(alias)?;
        admit(&f)?;
        assert_eq!(Ledger::aliases(&f.root)?, Vec::<Vec<PathBuf>>::new());
        assert_eq!(fs::read(f.root.join("public.txt"))?, b"complete");
    }
    let outside = f.setup.sandbox.home.join("outside-source");
    fs::write(&outside, b"complete")?;
    fs::hard_link(&outside, f.root.join("public-alias"))?;
    refused(&f, 1);
    fs::remove_file(f.root.join("public-alias"))?;
    admit(&f)?;
    f.finish();
    Ok(())
}
#[test]
fn ledger_outside_alias_accepted_window_and_full_verify() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-OUTSIDE")?;
    fs::write(f.root.join("public.txt"), "complete")?;
    admit(&f)?;
    let outside = f.setup.sandbox.home.join("outside.txt");
    fs::hard_link(f.root.join("public.txt"), &outside)?;
    // Accepted design window: outside names generate no RDCW event in the roots.
    admit(&f)?;
    assert_eq!(Ledger::aliases(&f.root)?, Vec::<Vec<PathBuf>>::new());
    Ledger::force_verify(&f.root)?;
    refused(&f, 1);
    fs::remove_file(&outside)?;
    Ledger::force_verify(&f.root)?;
    admit(&f)?;
    assert_eq!(Ledger::aliases(&f.root)?, Vec::<Vec<PathBuf>>::new());
    fs::hard_link(f.root.join("public.txt"), &outside)?;
    Ledger::age(&f.root)?;
    refused(&f, 1); // Aged admission performs the full verify without force_verify.
    fs::remove_file(&outside)?;
    admit(&f)?;
    f.finish();
    Ok(())
}
#[test]
fn ledger_inventory_change_overflow_and_directory_rename() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-INVALIDATION")?;
    let before = command_sandbox::discover_project_secret_inventory(&f.root)?;
    Ledger::admit(&f.root, &before)?;
    fs::create_dir_all(f.root.join("nested"))?;
    fs::write(f.root.join("nested/.env"), "private")?;
    let error = Ledger::admit(&f.root, &before).unwrap_err();
    assert!(
        error.to_string().contains("secret inventory changed"),
        "{error}"
    );
    fs::rename(f.root.join("nested"), f.root.join("moved"))?;
    let expected = vec![f.root.join("moved/.env")];
    assert_eq!(
        command_sandbox::discover_project_secrets(&f.root)?,
        expected
    );
    fs::hard_link(f.root.join("moved/.env"), f.root.join("alias"))?;
    Ledger::inject_overflow(&f.root)?;
    refused(&f, 1);
    fs::remove_file(f.root.join("alias"))?;
    admit(&f)?;
    assert_eq!(
        command_sandbox::discover_project_secrets(&f.root)?,
        expected
    );
    let swept = command_sandbox::sweep_new_secrets(&f.root, &before, &f.setup.sandbox.data)?;
    assert_eq!(swept, expected);
    assert_eq!(
        command_sandbox::discover_project_secrets(&f.root)?,
        Vec::<PathBuf>::new()
    );
    f.finish();
    Ok(())
}

mod performance;
mod recovery;

#[test]
fn ledger_post_run_background_and_admission_wait() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-POST-RUN")?;
    fs::write(f.root.join("public"), b"complete")?;
    let invocation = f.prepare("cmd /c echo complete");
    Ledger::age(&f.root)?;
    let output = f.launch(&invocation);
    assert!(output.status.success(), "{output:?}");
    assert_eq!(output.stdout, b"complete\r\n");
    let outside = f.setup.sandbox.home.join("after-run-alias");
    fs::hard_link(f.root.join("public"), &outside)?;
    Ledger::pause_verify(&f.root, true)?;
    let since = command_sandbox::discover_project_secret_inventory(&f.root)?;
    // Returns while the verifier is deliberately blocked, proving post-run is background.
    assert_eq!(
        command_sandbox::sweep_new_secrets(&f.root, &since, &f.setup.sandbox.data)?,
        Vec::<PathBuf>::new()
    );
    let (age, verifying) = Ledger::snapshot(&f.root)?;
    assert!(age >= 120_000 && verifying);
    let (tx, rx) = std::sync::mpsc::channel();
    let root = f.root.clone();
    let waiter = std::thread::spawn(move || {
        let _ = tx.send(Ledger::admit(&root, &since));
    });
    assert!(rx.recv_timeout(Duration::from_millis(30)).is_err());
    Ledger::pause_verify(&f.root, false)?;
    let error = rx
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap_err();
    assert!(
        error.to_string().contains("project_write_link_aliases"),
        "{error}"
    );
    waiter.join().unwrap();
    let (age, verifying) = Ledger::snapshot(&f.root)?;
    assert!(age < 120_000 && !verifying);
    fs::remove_file(outside)?;
    Ledger::force_verify(&f.root)?;
    admit(&f)?;
    f.finish();
    Ok(())
}

#[test]
fn ledger_replays_events_consumed_by_overlapping_sweep() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger");
    let f = Fixture::new("WIN-LEDGER-REPLAY")?;
    admit(&f)?;
    let outside = f.setup.sandbox.home.join("outside-source");
    fs::write(&outside, b"complete")?;
    Ledger::pause_verify_commit(&f.root, true)?;
    let root = f.root.clone();
    let verifier = std::thread::spawn(move || Ledger::force_verify(&root));
    let deadline = Instant::now() + Duration::from_secs(2);
    while !Ledger::verify_commit_paused(&f.root)? {
        assert!(
            Instant::now() < deadline,
            "verifier did not reach commit barrier"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    fs::hard_link(&outside, f.root.join("alias"))?;
    assert_eq!(
        command_sandbox::sweep_new_secrets(&f.root, &Default::default(), &f.setup.sandbox.data)?,
        Vec::<PathBuf>::new()
    );
    assert_eq!(
        Ledger::aliases(&f.root)?.len(),
        1,
        "sweep consumed the event"
    );
    Ledger::pause_verify_commit(&f.root, false)?;
    verifier.join().unwrap()?;
    refused(&f, 1);
    fs::remove_file(f.root.join("alias"))?;
    admit(&f)?;
    f.finish();
    Ok(())
}
