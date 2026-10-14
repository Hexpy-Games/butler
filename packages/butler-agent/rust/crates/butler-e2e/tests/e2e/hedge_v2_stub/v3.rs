//! Stub checks for cross-chat recall, same-chat recall and the benchmark.
use super::{model, run, v2};
use butler_e2e::e2e::{HarnessError, sandbox::Sandbox};
use serde_json::json;

#[tokio::test]
async fn cross_chat_user_message_is_queryable_and_resolves() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (record, requests) = run("U1", "U1").await?;
    let outputs = requests.iter().flat_map(model::outputs).collect::<Vec<_>>();
    let source = v2::cases::CASES
        .iter()
        .find(|c| c.id == "U1")
        .unwrap()
        .turns[0]
        .1;
    assert!(
        outputs
            .iter()
            .any(|output| output.to_string().contains(source)),
        "{outputs:?}"
    );
    assert_eq!(record["items"]["age"]["status"], "resolved", "{record}");
    assert!(
        !record["memory_tool_calls"].as_array().unwrap().is_empty(),
        "{record}"
    );
    assert_eq!(record["reasked"], false);
    Ok(())
}
#[tokio::test]
async fn seven_turn_chat_scores_reasking_and_recall() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (mode, reasked, status) in [
        ("U2_reasked", true, "unresolved"),
        ("U2", false, "resolved"),
    ] {
        let (record, requests) = run(mode, "U2").await?;
        let case = v2::cases::CASES.iter().find(|c| c.id == "U2").unwrap();
        for (_, prompt) in &case.turns {
            assert!(
                requests.iter().any(|r| r.to_string().contains(prompt)),
                "{prompt}"
            );
        }
        assert_eq!(record["reasked"], reasked, "{record}");
        assert_eq!(record["d3_fail"], reasked);
        assert_eq!(record["items"]["leave"]["status"], status);
    }
    Ok(())
}
#[tokio::test]
async fn benchmark_fixture_scores_all_forty_rows() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let sandbox = Sandbox::new("HEDGE-V3-BENCH")?;
    let root = sandbox.workspace.clone();
    let output = tokio::task::spawn_blocking(move || -> Result<_, HarnessError> {
        v2::files::reset(&root, "R1")?;
        Ok(std::process::Command::new("tools/eval.sh")
            .arg("bench")
            .current_dir(root)
            .output()?)
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "a precision=0.875 recall=0.778 f1=0.824 p50_ms=41 cases=40\nb precision=0.842 recall=0.889 f1=0.865 p50_ms=43 cases=40\n"
    );
    Ok(())
}
#[tokio::test]
async fn judgment_and_recall_scoring_preserves_required_facts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (case, answer, resolved) in [
        ("R1", "후보 B 추천: recall 0.889, precision 0.842", true),
        (
            "J1",
            "배포 영향으로 보인다. 209 ms에서 338 ms. 롤백 비교.",
            true,
        ),
        (
            "J1",
            "배포 영향이라고 단정하기 어렵다. 209 ms에서 338 ms.",
            false,
        ),
        (
            "J2",
            "Yes, she is 13-15 weeks old now. Book a vet appointment.",
            true,
        ),
    ] {
        let mut row = json!({"case":case,"final_text":answer,"delivered":true});
        v2::score::score(&mut row);
        assert_eq!(
            row["items"]
                .as_object()
                .unwrap()
                .values()
                .all(|v| v["status"] == "resolved"),
            resolved,
            "{row}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn report_gates_accept_improvements_and_reject_regressions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let sandbox = Sandbox::new("HEDGE-V3-REPORT")?;
    let script =
        butler_e2e::e2e::binary::crate_root().join("scripts/hedge_eval_v2_report_smoke.py");
    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new("python3")
            .arg(script)
            .arg(sandbox.workspace)
            .output()
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}
