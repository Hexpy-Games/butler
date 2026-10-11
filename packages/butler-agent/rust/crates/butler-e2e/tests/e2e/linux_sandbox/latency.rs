//! Timed real-executable launches with identical, complete output assertions.
use super::*;
use std::{process::Stdio, time::Instant};

fn launch(invocation: &Invocation, cwd: &Path, home: &Path) -> Duration {
    let mut command = Command::new(&invocation.program);
    command
        .args(&invocation.arguments)
        .current_dir(cwd)
        .env("HOME", home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    butler_platform::process_control::isolate_group(&mut command);
    let started = Instant::now();
    let child = command.spawn().unwrap();
    let pid = child.id();
    let output = child.wait_with_output().unwrap();
    let elapsed = started.elapsed();
    assert!(output.status.success(), "{output:?}");
    assert!(output.stderr.is_empty(), "{output:?}");
    // exec must preserve both the launcher's PID and its process group.
    let expected = format!("{pid}\n{pid}\ncomplete-fixture\n");
    assert_eq!(output.stdout, expected.as_bytes());
    elapsed
}

fn percentile(values: &[Duration], percentile: usize) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort();
    sorted[(sorted.len() - 1) * percentile / 100].as_secs_f64() * 1000.0
}

#[tokio::test]
async fn perf_trampoline_start_latency_and_process_identity() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(command_sandbox::linux_test_host(), "Linux sandbox latency");
    let mut setup = Setup::new("LINUX-LATENCY")?;
    let cwd = setup.sandbox.workspace.join("프로젝트 ✓/깊은 경로");
    std::fs::create_dir_all(&cwd)?;
    std::fs::write(cwd.join("fixture.txt"), "complete-fixture\n")?;
    let environment = HashMap::from([("HOME".into(), setup.sandbox.home.display().to_string())]);
    let command = "printf '%s\\n' \"$$\"; ps -o pgid= -p $$ | tr -d ' '; cat fixture.txt";
    let plain =
        command_sandbox::login_shell(command, command_sandbox::ShellAccess::Full, &environment)
            .unwrap();
    let sandbox = command_sandbox::login_shell_contained(
        command,
        &environment,
        &[&setup.sandbox.data],
        &[&cwd],
    )
    .unwrap();
    let (mut baseline, mut contained, mut added) = (Vec::new(), Vec::new(), Vec::new());
    for index in 0..60 {
        let (a, b) = if index % 2 == 0 {
            let b = launch(&sandbox, &cwd, &setup.sandbox.home);
            (launch(&plain, &cwd, &setup.sandbox.home), b)
        } else {
            let a = launch(&plain, &cwd, &setup.sandbox.home);
            (a, launch(&sandbox, &cwd, &setup.sandbox.home))
        };
        baseline.push(a);
        contained.push(b);
        added.push(b.as_secs_f64() * 1000.0 - a.as_secs_f64() * 1000.0);
    }
    added.sort_by(f64::total_cmp);
    let p50 = added[29];
    let p95 = added[56];
    eprintln!(
        "LINUX-LATENCY N=60 baseline_p50_ms={:.3} baseline_p95_ms={:.3} contained_p50_ms={:.3} contained_p95_ms={:.3} added_p50_ms={p50:.3} added_p95_ms={p95:.3}",
        percentile(&baseline, 50),
        percentile(&baseline, 95),
        percentile(&contained, 50),
        percentile(&contained, 95)
    );
    butler_e2e::assert_wall_clock_budget!(
        Duration::from_secs_f64(p50.max(0.0) / 1000.0),
        Duration::from_millis(2),
        "Linux added launch latency p50",
    );
    setup.sandbox.mark_success();
    Ok(())
}
