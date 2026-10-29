//! Opt-in refusal diagnostics include the unchanged approval round trip.
use super::*;

pub(super) async fn operation(
    s: &Scenario,
    chat: &str,
    script: &provider::Script,
    case: &Case,
    access: Access,
) -> Result<(Value, Duration), HarnessError> {
    let result = observe_operation(s, chat, script, case, access).await?;
    let budget = Duration::from_secs(if case.refused { 1 } else { 5 });
    butler_e2e::assert_wall_clock_budget!(result.1, budget, case.tool);
    Ok(result)
}

/// The sampler checks the maximum of all observations against the same budget.
pub(super) async fn observe_operation(
    s: &Scenario,
    chat: &str,
    script: &provider::Script,
    case: &Case,
    access: Access,
) -> Result<(Value, Duration), HarnessError> {
    eprintln!(
        "Starting Windows capability: access={access:?} tool={} refused={} args={}",
        case.tool, case.refused, case.args
    );
    script.select(case.clone());
    let live = butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, 0).await?;
    let accepted = s.gw.say(chat, provider::PROMPT).await?;
    script.mark("say_returned");
    let id = s.gw.accepted_turn(&accepted).await?;
    let turn = live
        .wait_turn(
            &s.gw,
            chat,
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(15),
        )
        .await;
    if let Err(error) = &turn {
        eprintln!(
            "Windows capability wait failed: {error}; complete tool result={:?}",
            script.result.lock().unwrap()
        );
        eprintln!(
            "Windows capability disposition={:?}",
            script.disposition.lock().unwrap()
        );
    }
    let turn = turn?;
    script.mark("waiting_state");
    assert_eq!(turn["execution_controls"]["access_mode"], access.as_str());
    if turn_state(&turn) == "waiting_for_form" {
        // Stored ask_first is Ask every time: command admission precedes the
        // executor's credential refusal. Allow must never bypass that refusal.
        assert_eq!(access, Access::AskAlways);
        assert!(script.result.lock().unwrap().is_none(), "ran before Allow");
        let cards = s.gw.approval_requests(chat).await?;
        script.mark("approval_listed");
        let card = cards
            .iter()
            .find(|c| c["source_turn_id"] == id)
            .expect("visible exact approval card");
        assert_eq!(
            card["approval"]["action_kind"],
            if case.tool == "run_command" {
                "run_command"
            } else if matches!(case.tool, "read_file" | "list_files" | "grep_files") {
                "other"
            } else {
                "edit_files"
            }
        );
        let examples = if case.tool == "run_command" {
            json!([case.args["command"]])
        } else if case.tool == "list_files" {
            json!([s.sandbox.root.join(butler_platform::tool_paths::parse(
                &s.sandbox.root,
                case.args["root"].as_str().unwrap()
            )?)])
        } else if case.tool == "read_file" {
            json!([s.sandbox.root.join(butler_platform::tool_paths::parse(
                &s.sandbox.root,
                case.args["requests"][0]["path"].as_str().unwrap()
            )?)])
        } else {
            json!([if case.args["path"] == "home/.butler/../escape.txt" {
                "home/escape.txt"
            } else {
                case.args["path"].as_str().unwrap()
            }])
        };
        assert_eq!(cards.len(), 1, "exactly one approval, no fallback");
        assert_eq!(card["approval"]["examples"], examples);
        let operation = &card["approval"]["operation"];
        assert_eq!(operation["tool"], case.tool);
        assert_eq!(
            operation["access"],
            if matches!(case.tool, "read_file" | "list_files" | "grep_files")
                || matches!(
                    case.args["state_effect"].as_str(),
                    Some("read_only" | "validation")
                )
            {
                "read_only"
            } else {
                "change"
            }
        );
        if case.tool == "list_files" {
            assert_eq!(operation["targets"], json!([case.args["root"]]));
        } else if case.tool == "run_command" {
            assert_eq!(operation["command"], case.args["command"]);
            let cwd = case.args["cwd"].as_str().filter(|path| *path != ".");
            let target = cwd.map_or_else(
                || {
                    s.sandbox
                        .root
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                },
                str::to_owned,
            );
            assert_eq!(operation["targets"], json!([target]));
        }
        if case.tool == "write_file" {
            assert!(
                !s.sandbox
                    .root
                    .join(case.args["path"].as_str().unwrap())
                    .exists()
            );
        }
        script.mark("allow_submitted");
        let reply =
            s.gw.post(
                &format!(
                    "/authority-requests/{}/allow?session_id={chat}",
                    card["request_ref"].as_str().unwrap()
                ),
                json!({"scope":"once"}),
            )
            .await?;
        script.mark("allow_returned");
        assert_eq!(reply.status, 202, "{}", reply.text);
        assert_eq!(reply.data()["decision"], "allowed");
    } else if access == Access::AskAlways {
        panic!(
            "Mutation/command must show an approval card: {turn}; result={:?}",
            script.result.lock().unwrap()
        );
    }
    let terminal = live
        .wait_turn(
            &s.gw,
            chat,
            &id,
            butler_e2e::e2e::gateway::TERMINAL,
            Duration::from_secs(15),
        )
        .await;
    if terminal.is_err() {
        super::super::log_approval_timeout_diagnostics(s, chat, &id).await?;
    }
    let turn = terminal?;
    script.mark("terminal");
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    if case.tool == "run_command" {
        approval_resume::assert_single_operation(s, chat, &id).await?;
    }
    let (output, elapsed) = script
        .result
        .lock()
        .unwrap()
        .clone()
        .expect("model receives complete result");
    if case.refused {
        for [step, received, matched, logged] in script.diagnostics.lock().unwrap().iter() {
            eprintln!(
                "command_provider_callback step={step} received_us={received} matched_us={matched} logged_us={logged}"
            );
        }
    }
    diagnostic_logs(s, script);
    // Keep discovery's own counts and elapsed time even when the end-to-end
    // budget fails before verify() can inspect the complete result.
    if case.tool == "list_files" {
        eprintln!(
            "WINDOWS-BASIC discovery metrics={} truncated={} stopped_by={}",
            output["metrics"], output["truncated"], output["stopped_by"]
        );
    }
    if case.refused {
        let expected = if case.tool == "write_file" {
            "parent_traversal_not_allowed"
        } else {
            "protected_path"
        };
        assert!(output.to_string().contains(expected), "{output}");
        assert!(!output.to_string().contains("PRIVATE_CANARY"));
    } else {
        assert!(output["ok"] == true || output["exit_code"] == 0, "{output}");
    }
    eprintln!(
        "WINDOWS-BASIC {access:?} {} refused={} {:.1}ms",
        case.tool,
        case.refused,
        elapsed.as_secs_f64() * 1000.
    );
    Ok((output, elapsed))
}

// Emit each captured diagnostic once; preserve complete source logs in the harness.
pub(super) fn diagnostic_logs(s: &Scenario, script: &provider::Script) {
    use std::sync::atomic::Ordering;
    let logs = s.agent.logs();
    let lines = logs.lines().count();
    let previous = script.diagnostic_log_lines.swap(lines, Ordering::Relaxed);
    for line in logs
        .lines()
        .skip(previous)
        .filter(|line| line.starts_with("command_"))
    {
        eprintln!("{line}");
    }
}
