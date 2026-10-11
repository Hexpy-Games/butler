//! Public turn → publish → main-only host → compact diagnostics.
use super::{result, stub};
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::json;

#[tokio::test]
async fn output_self_check_host_is_private_and_correlated() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("OUTPUT-CHECK")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    for path in [
        "/internal/browser-host",
        "/internal/browser/calls",
        "/internal/browser-host/results/fake",
    ] {
        let method = if path.ends_with("host") {
            Method::GET
        } else {
            Method::POST
        };
        let reply =
            s.gw.send_with(
                method.clone(),
                path,
                (method == Method::POST).then_some("{}".into()),
                Some(&s.gw.token),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 403, "{path}: {}", reply.text);
        let reply = admin
            .send(
                method.clone(),
                path,
                (method == Method::POST).then(|| json!({})),
                &[("x-forwarded-for", "192.0.2.1")],
            )
            .await?;
        assert_eq!(reply.status, 403, "remote {path}: {}", reply.text);
    }
    let client = reqwest::Client::new();
    let mut stream = client
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let duplicate = admin
        .send(Method::GET, "/internal/browser-host", None, &[])
        .await?;
    assert_eq!(duplicate.status, 409);
    let host_admin = admin.clone();
    let host = tokio::spawn(async move {
        let mut buffer = String::new();
        for index in 0..3 {
            loop {
                if let Some(end) = buffer.find("\n\n") {
                    let event = buffer[..end].to_owned();
                    buffer.drain(..end + 2);
                    if let Some(data) = event.lines().find_map(|l| l.strip_prefix("data: ")) {
                        let frame: serde_json::Value = serde_json::from_str(data).unwrap();
                        assert_eq!(frame["op"], "output.check");
                        assert!(frame["args"]["url"].as_str().unwrap().contains("/__o/"));
                        let report = json!({"status":"ok","url":frame["args"]["url"],"title":"Fixture","load_ms":12,"errors":{"total":if index < 2 {8} else {0},"shown":if index == 0 {vec![format!("fixture console error {}", "출\n\"".repeat(200));5]} else if index == 1 {vec!["remaining error".to_owned();3]} else {vec![]}},"layout":{"blank":false,"overflow_px":{"desktop":0,"mobile":if index == 0 {900} else {0}}},"warnings":[],"next_cursor":5});
                        let reply = host_admin
                            .send(
                                Method::POST,
                                &format!(
                                    "/internal/browser-host/results/{}",
                                    frame["id"].as_str().unwrap()
                                ),
                                Some(report),
                                &[],
                            )
                            .await
                            .unwrap();
                        assert_eq!(reply.status, 200);
                        break;
                    }
                } else {
                    let chunk = stream.chunk().await.unwrap().unwrap();
                    buffer.push_str(std::str::from_utf8(&chunk).unwrap());
                }
            }
        }
    });
    let (turn, _) = s.turn("general", "Publish").await?;
    let checked = result(&s, &turn);
    assert_eq!(checked["check"]["status"], "issues");
    assert_eq!(checked["check"]["errors"]["total"], 8);
    assert_eq!(
        checked["check"]["errors"]["shown"]
            .as_array()
            .unwrap()
            .len(),
        5
    );
    assert_eq!(checked["check"]["layout"]["overflow_px"]["mobile"], 900);
    assert_eq!(checked["check"]["next_cursor"], 5);
    let cursor = admin
        .send(
            Method::POST,
            "/internal/browser/calls",
            Some(json!({"output_id":checked["output_id"],"session_id":"general","cursor":5})),
            &[],
        )
        .await?;
    assert_eq!(cursor.status, 200);
    let page: serde_json::Value = serde_json::from_str(&cursor.text).unwrap();
    assert_eq!(page["errors"]["total"], 8);
    assert_eq!(page["errors"]["shown"].as_array().unwrap().len(), 3);
    let (turn, _) = s.turn("general", "Fix").await?;
    assert_eq!(result(&s, &turn)["check"]["status"], "ok");
    host.await.unwrap();
    s.finish().await
}

#[tokio::test]
async fn output_check_is_discoverable_bounded_and_absent_from_default_schema()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("OUTPUT-CHECK-DISCOVERY")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    s.turn("general", "Publish").await?;
    let (turn, _) = s.turn("general", "Checks").await?;
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let mut stmt = db.prepare("SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='output_check' AND turn_id=?1 ORDER BY started_at, rowid").unwrap();
    let results: Vec<String> = stmt
        .query_map([&turn], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(results.len(), 7, "{results:?}");
    for result in &results[..6] {
        let value: serde_json::Value = serde_json::from_str(result).unwrap();
        assert_eq!(value["status"], "unavailable", "{value}");
        assert_eq!(value["reason"], "no_browser");
    }
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&results[6]).unwrap()["status"],
        "budget_exhausted"
    );
    for request in s.provider()?.requests() {
        if let Some(tools) = request["tools"].as_array() {
            let baseline: Vec<_> = tools
                .iter()
                .filter(|tool| {
                    tool["name"] != "output_publish" && tool["function"]["name"] != "output_publish"
                })
                .collect();
            let before = serde_json::to_vec(&baseline).unwrap().len();
            let after = serde_json::to_vec(tools).unwrap().len();
            eprintln!(
                "default provider schema: baseline={before} current={after} delta={:.3}%",
                100.0 * (after - before) as f64 / before as f64
            );
            assert!(
                after * 1000 <= before * 1010,
                "default schema grew more than 1.0%"
            );
        }
        assert!(
            request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .all(|tool| tool["name"] != "output_check"
                    && tool["function"]["name"] != "output_check")
        );
    }
    drop(stmt);
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn output_check_shutdown_preserves_active_input_and_drains_followup()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("OUTPUT-CHECK-QUIT")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    let mut host = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", s.agent.launch.admin_credential().unwrap())
        .send()
        .await?;
    assert_eq!(host.status(), 200);
    let running =
        butler_e2e::e2e::scenario::accepted_turn_id(&s.gw.say("general", "Publish").await?)?;
    let mut frame = String::new();
    while !frame.contains("output.check") {
        let chunk = tokio::time::timeout(std::time::Duration::from_secs(8), host.chunk())
            .await
            .unwrap()?
            .unwrap();
        frame.push_str(std::str::from_utf8(&chunk).unwrap());
    }
    let queued = s.gw.post("/session-queue", json!({"chat_id":"general","text":"Fix","client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    assert_eq!(queued.status, 202);
    s.restart().await?;
    drop(host);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let turns = s.gw.turns("general").await?;
        if let Some(followup) = turns.iter().find(|t| {
            butler_e2e::e2e::gateway::turn_id_of(t) != Some(running.as_str())
                && butler_e2e::e2e::gateway::turn_state(t) == "delivered"
        }) {
            assert_eq!(
                result(&s, butler_e2e::e2e::gateway::turn_id_of(followup).unwrap())["check"]["reason"],
                "no_browser"
            );
            let queue = s.gw.get("/session-queue?chat_id=general").await?;
            assert_eq!(queue.data()["paused"], false);
            assert!(
                queue.data()["queued_messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|m| m["state"] != "queued")
            );
            let interrupted = queue.data()["queued_messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["turn_id"] == running)
                .expect("active input retained for retry");
            assert_eq!(interrupted["state"], "failed");
            assert_eq!(interrupted["safe_error_code"], "turn_interrupted");
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "check shutdown left followup stuck: {turns:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    s.finish().await
}

#[tokio::test]
async fn output_check_host_disconnect_settles_turn_and_followup() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("OUTPUT-HOST-QUIT")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(host.status(), 200);
    let running =
        butler_e2e::e2e::scenario::accepted_turn_id(&s.gw.say("general", "Publish").await?)?;
    let mut frame = String::new();
    while !frame.contains("output.check") {
        let chunk = tokio::time::timeout(std::time::Duration::from_secs(8), host.chunk())
            .await
            .unwrap()?
            .unwrap();
        frame.push_str(std::str::from_utf8(&chunk).unwrap());
    }
    let queued = s.gw.post("/session-queue", json!({"chat_id":"general","text":"Fix","client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    assert_eq!(queued.status, 202);
    drop(host);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let turns = s.gw.turns("general").await?;
        if let Some(followup) = turns.iter().find(|t| {
            butler_e2e::e2e::gateway::turn_id_of(t) != Some(running.as_str())
                && butler_e2e::e2e::gateway::turn_state(t) == "delivered"
        }) {
            let check = result(&s, &running)["check"].clone();
            assert_eq!(check["status"], "unknown");
            assert!(matches!(
                check["reason"].as_str(),
                Some("browser_host_lost" | "timeout")
            ));
            assert_eq!(
                result(&s, butler_e2e::e2e::gateway::turn_id_of(followup).unwrap())["check"]["reason"],
                "no_browser"
            );
            assert!(turns.iter().any(|t| butler_e2e::e2e::gateway::turn_id_of(t)
                == Some(running.as_str())
                && butler_e2e::e2e::gateway::turn_state(t) == "delivered"));
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "host quit stranded queue: {turns:?}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    s.finish().await
}
