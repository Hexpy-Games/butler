//! Owner-scale walks preserve all file and link content within the same budget.
use super::*;
use std::time::Instant;

#[tokio::test]
async fn perf_project_secret_discovery_and_sweep() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host(),
        "Linux project sweep latency"
    );
    measure(false)
}

#[tokio::test]
async fn perf_project_secret_sweep_with_preexisting_links() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        command_sandbox::linux_test_host(),
        "Linux project sweep latency"
    );
    measure(true)
}

fn measure(links: bool) -> Result<(), HarnessError> {
    let mut setup = Setup::new(if links {
        "LINUX-L1-LINK-LATENCY"
    } else {
        "LINUX-L1-WALK-LATENCY"
    })?;
    let root = &setup.sandbox.workspace;
    for dir in 0..50 {
        let path = root.join(format!("src/d{dir}"));
        std::fs::create_dir_all(&path)?;
        for file in 0..100 {
            std::fs::write(path.join(format!("f{file}")), "complete")?;
            if links {
                butler_platform::secure_fs::symlink(
                    Path::new(&format!("f{file}")),
                    &path.join(format!("l{file}")),
                )?;
            }
        }
    }
    let protected = root.join("src/d49/.env");
    std::fs::write(&protected, "existing")?;
    let mut discover = Vec::new();
    let mut sweep = Vec::new();
    for index in 0..21 {
        let started = Instant::now();
        let secrets = command_sandbox::discover_project_secret_inventory(root)?;
        discover.push(started.elapsed());
        assert_eq!(&*secrets, std::slice::from_ref(&protected));
        let since = secrets;
        let planted = root.join(format!("src/d{index}/.key"));
        std::fs::write(&planted, "new")?;
        let started = Instant::now();
        let moved = command_sandbox::sweep_new_secrets(root, &since, &setup.sandbox.data)?;
        sweep.push(started.elapsed());
        assert_eq!(moved, vec![planted.clone()]);
        assert!(!planted.exists());
        assert_eq!(std::fs::read_to_string(&protected)?, "existing");
    }
    discover.sort();
    sweep.sort();
    eprintln!(
        "| Step (5,000 files, pre-existing links={links}) | p50 ms |\n| --- | ---: |\n| discovery | {:.3} |\n| sweep + quarantine | {:.3} |",
        discover[10].as_secs_f64() * 1000.0,
        sweep[10].as_secs_f64() * 1000.0
    );
    for (step, duration) in [("discovery", discover[10]), ("sweep", sweep[10])] {
        butler_e2e::assert_wall_clock_budget!(duration, Duration::from_millis(30), step);
    }
    let mut quarantines = std::fs::read_dir(setup.sandbox.data.join("sandbox-quarantine"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    quarantines.sort();
    assert_eq!(quarantines.len(), 21);
    for (index, run) in quarantines.iter().enumerate() {
        assert_eq!(
            std::fs::read_to_string(run.join(format!("src/d{index}/.key")))?,
            "new"
        );
    }
    // Complete tree and content remain intact, including the last directory.
    for dir in 0..50 {
        for file in 0..100 {
            if links {
                let link = root.join(format!("src/d{dir}/l{file}"));
                assert_eq!(
                    std::fs::read_link(&link)?,
                    PathBuf::from(format!("f{file}"))
                );
                assert_eq!(std::fs::read_to_string(link)?, "complete");
            }
            assert_eq!(
                std::fs::read_to_string(root.join(format!("src/d{dir}/f{file}")))?,
                "complete"
            );
        }
    }
    setup.sandbox.mark_success();
    Ok(())
}
