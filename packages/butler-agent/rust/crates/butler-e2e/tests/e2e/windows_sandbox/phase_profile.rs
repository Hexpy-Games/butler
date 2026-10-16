//! SSH can run cmd in MXC even when USER32-dependent children need a desktop.
//! These samples describe phases; only row14_latency enforces the desktop budget.
use super::*;
use std::time::Instant;

#[test]
fn cmd_phase_profile() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !command_sandbox::POSIX_SHELL
            && std::env::var("BUTLER_DEBUG_SANDBOX_TIMINGS").as_deref() == Ok("1"),
        "opt-in Windows phase profiling"
    );
    let f = Fixture::new("WIN-CMD-PHASES")?;
    for (name, script) in [
        ("command", "cmd /c echo complete"),
        ("extra_process", "cmd /c cmd /c echo complete"),
    ] {
        let plain =
            command_sandbox::login_shell(script, command_sandbox::ShellAccess::Full, &f.env)
                .unwrap();
        let mut delta = Vec::new();
        for index in 0..31 {
            let sample = |contained| {
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
                eprintln!(
                    "WINDOWS-CMD-SAMPLE case={name} index={index} contained={contained} elapsed_ms={elapsed:.3}"
                );
                elapsed
            };
            let (plain, contained) = if index % 2 == 0 {
                let plain = sample(false);
                (plain, sample(true))
            } else {
                let contained = sample(true);
                (sample(false), contained)
            };
            if index > 0 {
                delta.push(contained - plain);
            }
        }
        delta.sort_by(f64::total_cmp);
        eprintln!(
            "WINDOWS-CMD-PHASES case={name} samples=30 added_p50_ms={:.3} complete_output=true desktop_acceptance=false",
            f64::midpoint(delta[14], delta[15])
        );
    }
    f.finish();
    Ok(())
}

#[test]
fn cmd_grant_boundaries() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(
        !command_sandbox::POSIX_SHELL
            && std::env::var("BUTLER_DEBUG_SANDBOX_TIMINGS").as_deref() == Ok("1"),
        "opt-in Windows cmd containment probe"
    );
    let mut f = Fixture::new("WIN-CMD-GRANTS")?;
    // An admitted tool search directory may contain the writable project.
    // Its inherited read grant must not erase the more specific .git rules.
    let search = f.root.parent().unwrap();
    f.env.insert(
        "PATH".into(),
        format!("{};{}", search.display(), f.env["PATH"]),
    );
    for name in [".git", "sub/.git"] {
        std::fs::create_dir_all(f.root.join(name))?;
        std::fs::write(f.root.join(name).join("config"), "complete\r\n")?;
    }
    std::fs::write(f.root.join(".env"), "private")?;
    let output = f.pass(r"cmd /c type .git\config & type sub\.git\config");
    assert_eq!(output.stdout, b"complete\r\ncomplete\r\n");
    for name in [r".git\config", r"sub\.git\config"] {
        f.deny(&format!("cmd /c echo changed>{name}"));
        assert_eq!(std::fs::read(f.root.join(name))?, b"complete\r\n");
    }
    f.deny("cmd /c type .env");
    let output = f.pass("cmd /c (echo complete)>made.txt & type made.txt");
    assert_eq!(output.stdout, b"complete\r\n");
    assert_eq!(std::fs::read(f.root.join("made.txt"))?, b"complete\r\n");
    f.finish();
    Ok(())
}
