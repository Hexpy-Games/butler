//! Repeated lexical refusals retain their complete result without running a shell.
use super::*;

#[tokio::test]
async fn lexical_refusals_keep_complete_results_without_shell_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for access in [Access::AskAlways, Access::FullAccess] {
        let (s, chat, script, server) = setup(access).await?;
        let initial_logs = s.agent.logs().lines().count();
        // POSIX read observations use the OS sandbox; mutation admission exercises
        // the same lexical guard that Windows uses for registered read commands.
        let (command, effect) = if butler_platform::command_sandbox::POSIX_SHELL {
            ("printf changed > .ssh/id_ed25519", "mutation")
        } else {
            ("Get-Content -LiteralPath '.ssh/id_ed25519'", "read_only")
        };
        let case = Case {
            tool: "run_command",
            args: json!({"command":command,"summary":if effect == "mutation" { "Write file" } else { "Read file" },
                "state_effect":effect,"cwd":".","output_mode":"full"}),
            refused: true,
        };
        let mut expected = None;
        let mut timings = Vec::new();
        let mut receipts = std::collections::HashSet::new();
        for _ in 0..4 {
            let (mut output, elapsed) = operation(&s, &chat, &script, &case, access).await?;
            assert_eq!(output["ok"], false);
            assert_eq!(output["exit_code"], 1);
            assert_eq!(output["timed_out"], false);
            assert_eq!(output["stdout"], "");
            assert_eq!(output["error"], "protected_path");
            assert_eq!(output["command"], case.args["command"]);
            if effect == "mutation" {
                let receipt = output
                    .as_object_mut()
                    .unwrap()
                    .remove("effect_receipt")
                    .unwrap();
                assert_eq!(receipt.as_object().unwrap().len(), 5);
                assert_eq!(receipt["capability"], "run_command");
                assert_eq!(receipt["target"], "workspace-command:.");
                assert_eq!(receipt["replayed"], false);
                chrono::DateTime::parse_from_rfc3339(receipt["applied_at"].as_str().unwrap())
                    .unwrap();
                assert_ne!(receipt["receipt_id"].as_str().unwrap(), "");
                assert!(receipts.insert(receipt["receipt_id"].as_str().unwrap().to_owned()));
            }
            if let Some(expected) = &expected {
                assert_eq!(&output, expected, "complete refusal stays identical");
            } else {
                expected = Some(output);
            }
            timings.push(elapsed.as_micros());
        }
        let logs = s
            .agent
            .logs()
            .lines()
            .skip(initial_logs)
            .collect::<Vec<_>>()
            .join("\n");
        for forbidden in [
            "command_process_timing",
            "phase=git_snapshot",
            "phase=registered_output",
            "phase=guided_output",
        ] {
            assert!(
                !logs.contains(forbidden),
                "refusal entered shell work: {logs}"
            );
        }
        timings.sort_unstable();
        eprintln!(
            "REFUSAL-SAMPLES access={access:?} n=4 p50_us={} max_us={}",
            timings[1].midpoint(timings[2]),
            timings[3]
        );
        s.finish().await?;
        server.abort();
    }
    Ok(())
}

/// Health has no model, approval, tool, or storage work: measure the same local HTTP transport.
#[tokio::test]
async fn approval_transport_noop_control() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _, _, server) = setup(Access::AskAlways).await?;
    let mut samples = Vec::new();
    for _ in 0..20 {
        let started = Instant::now();
        let reply = s.gw.get("/health").await?;
        let elapsed = started.elapsed();
        assert_eq!(reply.status, 200, "{}", reply.text);
        assert_eq!(reply.data()["ok"], true);
        butler_e2e::assert_wall_clock_budget!(elapsed, Duration::from_secs(1), "health control");
        samples.push(elapsed.as_micros());
    }
    samples.sort_unstable();
    eprintln!(
        "REFUSAL-CONTROL n=20 p50_us={} max_us={}",
        samples[9].midpoint(samples[10]),
        samples[19]
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
