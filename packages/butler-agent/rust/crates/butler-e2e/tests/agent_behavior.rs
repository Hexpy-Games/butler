//! Comparative behavior evaluation. Live calls are restricted to gpt-6-luna.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    reason = "evaluation assertions"
)]
#[path = "support/behavior_checks.rs"]
mod checks;
#[path = "support/behavior_fixture.rs"]
mod fixture;
use butler_e2e::e2e::{
    HarnessError, live,
    scenario::{Access, Setup, accepted_turn_id},
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf, time::Duration};

fn output() -> Result<PathBuf, HarnessError> {
    let path = PathBuf::from(
        std::env::var("BUTLER_BEHAVIOR_OUTPUT")
            .map_err(|e| butler_e2e::e2e::harness_error(e.to_string()))?,
    );
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn scenarios() -> Result<Vec<Value>, HarnessError> {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/agent-behavior/scenarios.json"))?;
    assert!(cases.len() >= 30);
    Ok(cases)
}

async fn evaluate(
    case: &Value,
    repeat: usize,
    out: &std::path::Path,
) -> Result<Value, HarnessError> {
    let id = format!("{}-{repeat}", case["id"].as_str().unwrap());
    let mut setup = Setup::new(&id)?
        .cassette(&id)
        .record_into(out.join("cassettes").join(&id))
        .env("BUTLER_E2E_APP_NOW", chrono::Utc::now().to_rfc3339());
    if case["access"] == "ask_first" {
        setup = setup.access(Access::AskFirst);
    }
    fixture::seed(&setup.sandbox.data, case)?;
    let s = setup.start().await?;
    let chat = fixture::configure(&s, case).await?;
    if case["fault"].is_string() {
        use butler_e2e::e2e::faults::{ArgsMutation, Fault, Transform};
        s.provider()?.inject(Fault::first_call(
            case["prompt"].as_str().unwrap(),
            Transform::MutateToolArgs(ArgsMutation::WrongTypes),
        ))?;
    }
    live::spend_turn()?;
    let turn_id = accepted_turn_id(&s.gw.say(&chat, case["prompt"].as_str().unwrap()).await?)?;
    let turn =
        s.gw.wait_turn(
            &chat,
            &turn_id,
            &[
                "delivered",
                "failed",
                "runtime_fault",
                "waiting_for_approval",
                "waiting_for_form",
            ],
            Duration::from_secs(300),
        )
        .await?;
    let messages = s.gw.messages(&chat).await?;
    let calls = checks::calls(&s, &turn_id)?;
    let approvals = s.gw.approval_requests(&chat).await?;
    let requests: Vec<_> = s
        .provider()?
        .requests()
        .into_iter()
        .filter(|r| r["tools"].is_array())
        .collect();
    assert!(!requests.is_empty(), "live request capture missing");
    let failures = checks::check(case, &s, &turn, &messages, &calls, &approvals)?;
    let sizes: Vec<_> = requests.iter().map(checks::tokens).collect();
    let result = json!({"id":id,"category":case["category"],"turn_id":turn_id,"pass":failures.is_empty(),
        "failures":failures,"request_tokens":sizes,"turn":turn,"messages":messages,"calls":calls,"approvals":approvals});
    fs::write(
        out.join(format!("{id}.json")),
        serde_json::to_vec_pretty(&result)?,
    )?;
    fs::write(
        out.join(format!("{id}-requests.json")),
        serde_json::to_vec_pretty(&requests)?,
    )?;
    // Parked forms/approvals are observations. Stop the sandbox without approving them.
    s.finish().await?;
    Ok(result)
}

#[tokio::test]
async fn comparative_live_behavior() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let cases = scenarios()?;
    let Some(provider) = live::gate("AGENT-BEHAVIOR")? else {
        return Ok(());
    };
    assert_eq!(provider.choice.model, "openai/gpt-6-luna");
    assert!(
        provider
            .matrix
            .iter()
            .all(|m| m.model == "openai/gpt-6-luna")
    );
    let out = output()?;
    let mut results = Vec::new();
    for repeat in 1..=3 {
        for batch in cases.chunks(2) {
            let completed = futures_util::future::join_all(
                batch.iter().map(|case| evaluate(case, repeat, &out)),
            )
            .await;
            for (case, outcome) in batch.iter().zip(completed) {
                match outcome {
                    Ok(result) => {
                        eprintln!("BEHAVIOR {} pass={}", result["id"], result["pass"]);
                        results.push(result);
                    }
                    Err(error) => {
                        results.push(json!({"id":format!("{}-{repeat}",case["id"].as_str().unwrap()),"category":case["category"],"pass":false,"harness_error":error.to_string()}));
                    }
                }
                fs::write(
                    out.join("results.json"),
                    serde_json::to_vec_pretty(&results)?,
                )?;
            }
        }
    }
    assert_eq!(results.len(), cases.len() * 3);
    assert!(
        results.iter().all(|r| r["pass"] == true),
        "see results.json for all failures"
    );
    Ok(())
}

/// Captures complete requests, including every schema, from real admission.
#[tokio::test]
async fn structural_prompt_sessions() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let out = output()?;
    let names = [
        "fresh",
        "ko",
        "persona",
        "eol",
        "rules",
        "duplicates",
        "project",
        "long_persona",
        "long_rules",
        "mcp",
    ];
    let mut results = Vec::new();
    for name in names {
        let case = json!({"fixture":name});
        let setup = Setup::new(&format!("PROMPT-{name}"))?
            .cassette("TURN-02")
            .replay_only();
        fixture::seed(&setup.sandbox.data, &case)?;
        let s = setup.start().await?;
        let chat = fixture::configure(&s, &case).await?;
        let (_, turn) = s.turn(&chat, "Reply with exactly the word: once").await?;
        assert_eq!(turn["state"], "delivered");
        let requests = s.provider()?.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        let instructions = request["instructions"].as_str().unwrap();
        assert!(!instructions.is_empty());
        assert!(!request["tools"].as_array().unwrap().is_empty());
        fs::write(
            out.join(format!("{name}.json")),
            serde_json::to_vec_pretty(request)?,
        )?;
        fs::write(out.join(format!("{name}.txt")), checks::render(request))?;
        results.push(json!({"session":name,"tokens":checks::tokens(request),"tools":request["tools"].as_array().unwrap().len()}));
        s.finish().await?;
    }
    fs::write(
        out.join("structural.json"),
        serde_json::to_vec_pretty(&results)?,
    )?;
    Ok(())
}
