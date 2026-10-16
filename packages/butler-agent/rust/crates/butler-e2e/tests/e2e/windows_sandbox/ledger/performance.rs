//! Fixed per-file scan budgets and exact inventory assertions at both scales.
use super::*;
use std::collections::BTreeSet;
fn populate(f: &Fixture, dirs: usize) -> std::io::Result<BTreeSet<PathBuf>> {
    let mut secrets = BTreeSet::new();
    std::thread::scope(|scope| -> std::io::Result<()> {
        let workers: Vec<_> = (0..16)
            .map(|worker| {
                scope.spawn(move || -> std::io::Result<()> {
                    for dir in (worker..dirs).step_by(16) {
                        let path = f.root.join(format!("d{dir:04}"));
                        fs::create_dir(&path)?;
                        for file in 0..50 {
                            fs::write(path.join(format!("f{file:02}")), b"complete")?;
                        }
                    }
                    Ok(())
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap()?;
        }
        Ok(())
    })?;
    // Deterministic random-looking depths/locations, both files and directories.
    for index in 0..50 {
        let parent = f.root.join(format!("d{:04}", (index * 631 + 17) % dirs));
        let parent = (0..index % 5).fold(parent, |p, depth| p.join(format!("n{depth}")));
        fs::create_dir_all(&parent)?;
        let path = parent.join(format!(".env-{index}"));
        if index % 2 == 0 {
            fs::create_dir(&path)?;
            fs::write(path.join("child"), b"private")?;
        } else {
            fs::write(&path, b"private")?;
        }
        secrets.insert(path);
    }
    Ok(secrets)
}
#[test]
fn ledger_100k_performance_and_exactness() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger perf");
    performance(2_000, "WIN-LEDGER-100K")
}
#[test]
fn ledger_300k_performance_and_exactness() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(!command_sandbox::POSIX_SHELL, "Windows ledger perf");
    performance(6_000, "WIN-LEDGER-300K")
}
fn performance(dirs: usize, name: &str) -> Result<(), HarnessError> {
    let f = Fixture::new(name)?;
    let expected = populate(&f, dirs)?;
    let start = Instant::now();
    command_sandbox::prewarm_project(&f.root);
    admit(&f)?;
    let build = start.elapsed();
    assert_eq!(Ledger::verified_files(&f.root)?, dirs * 50 + 50);
    assert_eq!(Ledger::aliases(&f.root)?, Vec::<Vec<PathBuf>>::new());
    let found: BTreeSet<_> = command_sandbox::discover_project_secrets(&f.root)?
        .into_iter()
        .collect();
    assert_eq!(found, expected);
    let mut samples = Vec::new();
    for _ in 0..30 {
        let start = Instant::now();
        admit(&f)?;
        samples.push(start.elapsed());
        assert_eq!(Ledger::aliases(&f.root)?, Vec::<Vec<PathBuf>>::new());
        assert_eq!(
            command_sandbox::discover_project_secrets(&f.root)?
                .into_iter()
                .collect::<BTreeSet<_>>(),
            expected
        );
    }
    samples.sort();
    let p50 = (samples[14] + samples[15]) / 2;
    let outside = f.setup.sandbox.home.join("outside-alias");
    fs::hard_link(f.root.join("d0000/f00"), &outside)?;
    fs::hard_link(f.root.join("d0000/f01"), f.root.join(".env"))?;
    fs::create_dir(f.root.join(".git"))?;
    fs::hard_link(f.root.join("d0000/f02"), f.root.join(".git/x"))?;
    for index in 0..5_000 {
        fs::write(f.root.join(format!("delta{index}")), b"complete")?;
    }
    let start = Instant::now();
    refused(&f, 2);
    let delta = start.elapsed();
    let aliases: BTreeSet<_> = Ledger::aliases(&f.root)?.into_iter().flatten().collect();
    assert_eq!(
        aliases,
        BTreeSet::from([f.root.join(".env"), f.root.join(".git/x")])
    );
    let start = Instant::now();
    Ledger::age(&f.root)?;
    refused(&f, 3);
    let verify = start.elapsed();
    assert_eq!(Ledger::verified_files(&f.root)?, dirs * 50 + 5_052);
    refused(&f, 3);
    let groups: BTreeSet<BTreeSet<_>> = Ledger::aliases(&f.root)?
        .into_iter()
        .map(|g| g.into_iter().collect())
        .collect();
    assert_eq!(
        groups,
        BTreeSet::from([
            BTreeSet::from([f.root.join("d0000/f00")]),
            BTreeSet::from([f.root.join("d0000/f01"), f.root.join(".env")]),
            BTreeSet::from([f.root.join("d0000/f02"), f.root.join(".git/x")]),
        ])
    );
    for alias in [outside, f.root.join(".env"), f.root.join(".git/x")] {
        fs::remove_file(alias)?;
    }
    admit(&f)?;
    assert_eq!(Ledger::aliases(&f.root)?, Vec::<Vec<PathBuf>>::new());
    assert_eq!(
        command_sandbox::discover_project_secrets(&f.root)?
            .into_iter()
            .collect::<BTreeSet<_>>(),
        Ledger::tree(&f.root)?.into_iter().collect()
    );
    for index in 0..5_000 {
        assert_eq!(fs::read(f.root.join(format!("delta{index}")))?, b"complete");
    }
    eprintln!(
        "WINDOWS-LEDGER files={} dirs={} secrets=50 build_ms={:.3} admission_p50_ms={:.3} delta_5000_ms={:.3} verify_ms={:.3} complete=true",
        dirs * 50,
        dirs,
        build.as_secs_f64() * 1000.,
        p50.as_secs_f64() * 1000.,
        delta.as_secs_f64() * 1000.,
        verify.as_secs_f64() * 1000.
    );
    let scale = (dirs / 2_000) as u64;
    butler_e2e::assert_wall_clock_budget!(build, Duration::from_secs(2 * scale), "ledger build");
    butler_e2e::assert_wall_clock_budget!(p50, Duration::from_millis(50), "ledger admission p50");
    butler_e2e::assert_wall_clock_budget!(delta, Duration::from_millis(100), "ledger 5000 delta");
    butler_e2e::assert_wall_clock_budget!(verify, Duration::from_secs(scale), "ledger full verify");
    f.finish();
    Ok(())
}
