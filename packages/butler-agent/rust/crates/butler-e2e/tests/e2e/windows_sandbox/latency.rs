use super::*;
use std::time::Instant;

// Micro watch: half of the 20 ms p95 per-tool-call overhead budget.
const WATCH_P95_MS: u64 = 10;

#[test]
fn row14_latency() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(desktop(), "interactive Windows desktop required");
    let f = Fixture::new("WIN-14")?;
    let script = "cmd /c echo complete";
    let plain =
        command_sandbox::login_shell(script, command_sandbox::ShellAccess::Full, &f.env).unwrap();
    setup_complete!(f);
    let launch = |contained| {
        let start = Instant::now();
        let out = if contained {
            f.run(script)
        } else {
            f.launch(&plain)
        };
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        assert!(out.status.success(), "{out:?}");
        assert_eq!(out.stdout, b"complete\r\n");
        for line in String::from_utf8_lossy(&out.stderr).lines() {
            assert!(line.starts_with("command_sandbox_phase phase="), "{out:?}");
            eprintln!("{line}");
        }
        eprintln!("command_sandbox_sample contained={contained} elapsed_ms={elapsed:.3}");
        elapsed
    };
    launch(false);
    launch(true);
    let mut delta = Vec::new();
    for index in 0..30 {
        let (a, b) = if index % 2 == 0 {
            let a = launch(false);
            (a, launch(true))
        } else {
            let b = launch(true);
            (launch(false), b)
        };
        delta.push(b - a);
    }
    delta.sort_by(f64::total_cmp);
    let p50 = f64::midpoint(delta[14], delta[15]);
    let p95 = delta[28];
    eprintln!(
        "WINDOWS-MXC-LATENCY samples=30 added_p50_ms={p50:.3} added_p95_ms={p95:.3} watch_p95_ms={WATCH_P95_MS} powershell_startup=false complete_output=true"
    );
    butler_e2e::assert_wall_clock_budget!(
        std::time::Duration::from_secs_f64(p95.max(0.0) / 1000.0),
        std::time::Duration::from_millis(WATCH_P95_MS),
        "Windows MXC added p95 latency",
    );
    f.finish();
    Ok(())
}
