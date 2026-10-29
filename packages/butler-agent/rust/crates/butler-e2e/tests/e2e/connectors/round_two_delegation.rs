use super::round_two_access::{attended, no_schedule, schedule};
use super::*;
use crate::access_tiers::stub::{self as script, call};
use butler_e2e::e2e::scenario::Access;

#[tokio::test]
async fn round_two_delegated_connector_outward_requires_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    delegated("run_command", json!({"command":"echo outward > outward.txt","summary":"Send item","state_effect":"remote_observation"})).await
}
#[tokio::test]
async fn round_two_delegated_connector_schedule_requires_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut arguments = schedule()["arguments"].clone();
    arguments["session_id"] = "general".into();
    delegated("create_automation", arguments).await
}
async fn delegated(name: &str, arguments: Value) -> Result<(), HarnessError> {
    let (url, script, server) = script::start().await?;
    let setup = setup("PC2-DELEGATED")?
        .access(Access::FullAccess)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    let mut s = setup.start().await?;
    let (proxy, priming) = prime_delegation_policy(&s, &url).await?;
    s.agent
        .launch
        .set_env("BUTLER_CHATGPT_API_BASE_URL", format!("{proxy}/v1"));
    s.restart().await?;
    script.rounds.lock().unwrap().insert("fixture-call:".into(), vec![call("delegate", "delegate_to_steward", &json!({"request":"Review connected items","checks":["Items reviewed"],"safe_title":"Review items"}))]);
    let mut steps = vec![
        call(
            "plan",
            "replace_work_plan",
            &json!({"objective":"Review items","execution_mode":"direct","checks":["Items reviewed"],"actions":[{"action_key":"review","description":"Review connected items","dependency_keys":[]}]}),
        ),
        call(
            "review",
            "record_work_review",
            &json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
        ),
    ];
    if name == "create_automation" {
        steps.push(call(
            "child-describe",
            "tool_describe",
            &json!({"ids":["native:create_automation"]}),
        ));
        steps.push(call(
            "child-effect",
            "tool_call",
            &json!({"id":"native:create_automation","arguments":arguments}),
        ));
    } else {
        let mut arguments = arguments.clone();
        arguments["cwd"] = s.sandbox.home.to_string_lossy().into_owned().into();
        steps.push(call("child-effect", name, &arguments));
    }
    script
        .rounds
        .lock()
        .unwrap()
        .insert("role: steward".into(), steps);
    let _ = attended(&s, json!({"name":"delegate_to_steward","arguments":{}})).await?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut bookkeeping = std::collections::BTreeSet::new();
    loop {
        no_schedule(&s).await?;
        let cards = s.gw.approval_requests("general").await?;
        if cards.iter().any(|c| c.to_string().contains(name)) {
            assert!(
                bookkeeping.contains("replace_work_plan")
                    && bookkeeping.contains("record_work_review")
            );
            break;
        }
        for card in cards {
            let tool = card["approval"]["operation"]["tool"].as_str().unwrap();
            assert!(
                matches!(tool, "replace_work_plan" | "record_work_review"),
                "unexpected card: {card}"
            );
            bookkeeping.insert(tool.to_owned());
            let reference = card["request_ref"].as_str().unwrap();
            let allowed =
                s.gw.post(
                    &format!("/authority-requests/{reference}/allow?session_id=general"),
                    json!({"scope":"once"}),
                )
                .await?;
            assert_eq!(allowed.status, 202, "{allowed:?}");
        }
        assert!(
            Instant::now() < deadline,
            "delegated {name} produced no approval card"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    no_schedule(&s).await?;
    assert!(!s.sandbox.home.join("outward.txt").exists());
    s.finish().await?;
    server.abort();
    priming.abort();
    Ok(())
}

// Exercise the supported explicit native-tool policy while keeping role defaults.
// Prime the parent's stored policy after binding and before its handoff dispatch.
async fn prime_delegation_policy(
    s: &Scenario,
    backend: &str,
) -> Result<(String, tokio::task::JoinHandle<()>), HarnessError> {
    use axum::{
        Json, Router, extract::State, http::HeaderMap, response::IntoResponse, routing::post,
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    #[derive(Clone)]
    struct Policy {
        database: PathBuf,
        backend: String,
        primed: Arc<AtomicBool>,
    }
    async fn reply(
        State(policy): State<Policy>,
        mut headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> impl IntoResponse {
        if body["tools"].as_array().is_some_and(|v| !v.is_empty())
            && !policy.primed.swap(true, Ordering::SeqCst)
        {
            let connection = rusqlite::Connection::open(&policy.database).unwrap();
            let changed = connection.execute("UPDATE session_bindings SET metadata_json=json_insert(metadata_json,'$.runtimePolicy.requiredNativeTools[#]','create_automation') WHERE role='butler'", []).unwrap();
            assert!(changed > 0, "parent policy must be bound before handoff");
        }
        headers.remove("host");
        headers.remove("content-length");
        let response = reqwest::Client::new()
            .post(format!("{}/v1/responses", policy.backend))
            .headers(headers)
            .json(&body)
            .send()
            .await
            .unwrap();
        (
            response.status(),
            [("content-type", "text/event-stream")],
            response.bytes().await.unwrap(),
        )
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let state = Policy {
        database: s.sandbox.data.join("runtime/session-store.sqlite"),
        backend: backend.into(),
        primed: Arc::new(AtomicBool::new(false)),
    };
    let app = Router::new()
        .route("/v1/responses", post(reply))
        .with_state(state);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((url, task))
}
