//! Public stub turns and the same private event channel consumed by the App.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Setup, accepted_turn_id},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;

struct Host {
    stream: reqwest::Response,
    buffer: String,
    admin: AdminClient,
}
impl Host {
    async fn attach(admin: AdminClient) -> Result<Self, HarnessError> {
        let stream = reqwest::Client::new()
            .get(format!("{}/internal/browser-host", admin.gw.base))
            .bearer_auth(&admin.gw.token)
            .header("x-butler-admin", &admin.admin)
            .send()
            .await?;
        assert_eq!(stream.status(), 200);
        Ok(Self {
            stream,
            buffer: String::new(),
            admin,
        })
    }
    async fn next(&mut self) -> Result<Value, HarnessError> {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if let Some(end) = self.buffer.find("\n\n") {
                    let event = self.buffer[..end].to_owned();
                    self.buffer.drain(..end + 2);
                    if let Some(data) = event.lines().find_map(|l| l.strip_prefix("data: ")) {
                        return Ok(serde_json::from_str(data)?);
                    }
                } else {
                    let bytes = self.stream.chunk().await?.expect("host connected");
                    self.buffer.push_str(std::str::from_utf8(&bytes).unwrap());
                }
            }
        })
        .await
        .expect("browser release event must arrive")
    }
    async fn dispatch(&mut self) -> Result<Value, HarnessError> {
        let start = self.next().await?;
        assert_eq!(start["op"], "use.started", "{start}");
        let frame = self.next().await?;
        assert_eq!(start["id"], frame["id"]);
        assert_eq!(start["session"], frame["session"]);
        assert_eq!(start["turn_id"], frame["turn_id"]);
        Ok(frame)
    }
    async fn result(&self, frame: &Value, result: Value) -> Result<(), HarnessError> {
        let reply = self
            .admin
            .send(
                Method::POST,
                &format!(
                    "/internal/browser-host/results/{}",
                    frame["id"].as_str().unwrap()
                ),
                Some(result),
                &[],
            )
            .await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        Ok(())
    }
    async fn snapshot(&self, active: bool) -> Result<(), HarnessError> {
        let reply = self.admin.send(Method::POST,"/internal/browser-host/events",Some(json!({"tabs":[{"id":"fixture","owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","inUse":active,"url":"https://example.com"}]})),&[]).await?;
        assert_eq!(reply.status, 200);
        Ok(())
    }
    async fn released(&mut self, frame: &Value) -> Result<(), HarnessError> {
        let end = self.next().await?;
        assert_eq!(end["op"], "use.ended", "{end}");
        assert_eq!(end["session"], frame["session"]);
        assert_eq!(
            end["args"]["id"], frame["id"],
            "release exact call, not another use"
        );
        self.snapshot(false).await
    }
}

#[tokio::test]
async fn browser_usage_stub_turn_releases_each_completed_call() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-USE-COMPLETE")?
        .stub_cassette(stub::cassette(false)?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = Host::attach(admin).await?;
    let accepted = s.gw.say("general", "Use browser then finish").await?;
    let turn = accepted_turn_id(&accepted)?;
    for op in ["tab.open", "tab.observe", "tab.observe"] {
        let frame = host.dispatch().await?;
        assert_eq!(frame["op"], op);
        if op == "tab.observe" {
            assert_eq!(frame["pointer"]["mode"], "observe");
        }
        host.snapshot(true).await?;
        host.result(&frame,json!({"status":"ok","tab":"fixture","url":"https://example.com","text":"Fixture","epoch":1})).await?;
        host.released(&frame).await?;
    }
    let completed =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(10))
            .await?;
    assert_eq!(
        butler_e2e::e2e::gateway::turn_state(&completed),
        "delivered"
    );
    let finished = host.next().await?;
    assert_eq!(finished["op"], "use.finished");
    assert_eq!(finished["turn_id"], turn);
    eprintln!("3 browser calls: dispatch -> native result -> exact release; turn delivered");
    s.finish().await
}

#[tokio::test]
async fn browser_usage_failure_and_timeout_release() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-USE-FAIL")?
        .stub_cassette(stub::cassette(false)?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = Host::attach(admin).await?;
    let turn = accepted_turn_id(&s.gw.say("general", "Use browser then finish").await?)?;
    let open = host.dispatch().await?;
    host.snapshot(true).await?;
    host.result(
        &open,
        json!({"status":"ok","tab":"fixture","url":"https://example.com"}),
    )
    .await?;
    host.released(&open).await?;
    let failure = host.dispatch().await?;
    host.snapshot(true).await?;
    host.result(
        &failure,
        json!({"status":"unknown","reason":"executor_error"}),
    )
    .await?;
    host.released(&failure).await?;
    let timeout = host.dispatch().await?;
    host.snapshot(true).await?;
    // Keep the real 5s observe deadline; no timeout override or live model.
    host.released(&timeout).await?;
    let completed =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(10))
            .await?;
    assert_eq!(
        butler_e2e::e2e::gateway::turn_state(&completed),
        "delivered"
    );
    s.finish().await
}

#[tokio::test]
async fn browser_usage_user_cancel_releases_active_open() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-USE-CANCEL")?
        .stub_cassette(stub::cassette(false)?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = Host::attach(admin).await?;
    let turn = accepted_turn_id(&s.gw.say("general", "Use browser then finish").await?)?;
    let open = host.dispatch().await?;
    assert_eq!(open["op"], "tab.open");
    // Open has no tab id yet: cancellation must still release its exact use.
    let cancelled =
        s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
            .await?;
    assert_eq!(cancelled.status, 202);
    host.released(&open).await?;
    let completed =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(10))
            .await?;
    assert_eq!(
        butler_e2e::e2e::gateway::turn_state(&completed),
        "cancelled"
    );
    let late = host
        .admin
        .send(
            Method::POST,
            &format!(
                "/internal/browser-host/results/{}",
                open["id"].as_str().unwrap()
            ),
            Some(json!({"status":"ok","tab":"late"})),
            &[],
        )
        .await?;
    assert_eq!(late.status, 409, "cancelled result cannot revive use");
    s.finish().await
}

#[tokio::test]
async fn browser_usage_overlapping_calls_release_only_their_own_use() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-USE-OVERLAP")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = Host::attach(admin.clone()).await?;
    host.snapshot(false).await?;
    let first_admin = admin.clone();
    let first = tokio::spawn(async move {
        first_admin
            .send(
                Method::POST,
                "/internal/browser/calls",
                Some(json!({"op":"tab.observe","session":"general","tab":"fixture","args":{}})),
                &[],
            )
            .await
    });
    let first_frame = host.dispatch().await?;
    let second = tokio::spawn(async move {
        admin
            .send(
                Method::POST,
                "/internal/browser/calls",
                Some(json!({"op":"tab.observe","session":"general","tab":"fixture","args":{}})),
                &[],
            )
            .await
    });
    let second_frame = host.dispatch().await?;
    assert_ne!(first_frame["id"], second_frame["id"]);
    host.result(&first_frame, json!({"status":"ok"})).await?;
    let released = host.next().await?;
    assert_eq!(released["op"], "use.ended");
    assert_eq!(released["args"]["id"], first_frame["id"]);
    assert!(!second.is_finished(), "other browser call remains active");
    host.result(&second_frame, json!({"status":"ok"})).await?;
    host.released(&second_frame).await?;
    assert_eq!(first.await.unwrap()?.status, 200);
    assert_eq!(second.await.unwrap()?.status, 200);
    s.finish().await
}

#[tokio::test]
async fn browser_usage_turn_error_emits_finish() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-USE-TURN-ERROR")?
        .stub_cassette(stub::cassette(true)?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = Host::attach(admin).await?;
    let turn = accepted_turn_id(&s.gw.say("general", "Use browser then finish").await?)?;
    for op in ["tab.open", "tab.observe", "tab.observe"] {
        let frame = host.dispatch().await?;
        assert_eq!(frame["op"], op);
        host.snapshot(true).await?;
        host.result(&frame,json!({"status":"ok","tab":"fixture","url":"https://example.com","text":"Fixture","epoch":1})).await?;
        host.released(&frame).await?;
    }
    let completed =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(10))
            .await?;
    assert!(matches!(
        butler_e2e::e2e::gateway::turn_state(&completed),
        "failed" | "runtime_fault"
    ));
    let finished = host.next().await?;
    assert_eq!(finished["op"], "use.finished");
    assert_eq!(finished["turn_id"], turn);
    s.finish().await
}

#[tokio::test]
async fn browser_usage_restart_discards_pending_use_and_late_results() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-USE-RESTART")?
        .stub_cassette(stub::cassette(false)?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = Host::attach(admin).await?;
    s.gw.say("general", "Use browser then finish").await?;
    let open = host.dispatch().await?;
    assert_eq!(open["op"], "tab.open");
    s.restart().await?;
    drop(host);
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let late = admin
        .send(
            Method::POST,
            &format!(
                "/internal/browser-host/results/{}",
                open["id"].as_str().unwrap()
            ),
            Some(json!({"status":"ok","tab":"late"})),
            &[],
        )
        .await?;
    assert_eq!(late.status, 409, "old use cannot reappear after restart");
    let host = Host::attach(admin).await?;
    host.snapshot(false).await?;
    let observed = host
        .admin
        .send(
            Method::POST,
            "/internal/browser/calls",
            Some(json!({"op":"tab.observe","session":"other","tab":"fixture","args":{}})),
            &[],
        )
        .await?;
    assert!(
        observed.text.contains("not_your_tab"),
        "reconnect preserves the owner fence"
    );
    s.finish().await
}

#[tokio::test]
async fn browser_usage_user_cancel_mid_action_releases() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-USE-ACT-CANCEL")?
        .stub_cassette(stub::action_cassette()?)
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = Host::attach(admin).await?;
    let turn = accepted_turn_id(&s.gw.say("general", "Use browser then finish").await?)?;
    let open = host.dispatch().await?;
    host.snapshot(true).await?;
    host.result(
        &open,
        json!({"status":"ok","tab":"fixture","url":"https://example.com"}),
    )
    .await?;
    host.released(&open).await?;
    let prepare = host.dispatch().await?;
    assert_eq!(prepare["op"], "tab.prepare");
    host.result(&prepare,json!({"status":"ok","tab":"fixture","url":"https://example.com","steps":[{"hit":{"role":"button","name":"Confirm"}},{"hit":{"role":"button","name":"Confirm"}}]})).await?;
    host.released(&prepare).await?;
    let waiting = host.next().await?;
    assert_eq!(waiting["op"], "tab.waiting");
    host.result(&waiting, json!({"status":"ok"})).await?;
    let action = host.dispatch().await?;
    assert_eq!(action["op"], "tab.act");
    assert_eq!(action["pointer"]["mode"], "batch");
    assert_eq!(action["args"]["steps"].as_array().unwrap().len(), 2);
    let cancelled =
        s.gw.post(&format!("/turns/{turn}/cancel"), json!({}))
            .await?;
    assert_eq!(cancelled.status, 202);
    host.released(&action).await?;
    let completed =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(10))
            .await?;
    assert_eq!(
        butler_e2e::e2e::gateway::turn_state(&completed),
        "cancelled"
    );
    s.finish().await
}

#[tokio::test]
async fn browser_usage_policy_revocation_still_closes_the_tab() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-USE-POLICY")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = Host::attach(admin.clone()).await?;
    let call = tokio::spawn(async move {
        admin.send(Method::POST,"/internal/browser/calls",Some(json!({"op":"tab.open","session":"general","args":{"url":"https://example.com"}})),&[]).await
    });
    let open = host.dispatch().await?;
    host.result(
        &open,
        json!({"status":"ok","tab":"fixture","url":"http://127.0.0.1/"}),
    )
    .await?;
    let revoked = host.next().await?;
    assert_eq!(revoked["op"], "use.revoked");
    assert_eq!(revoked["tab"], "fixture");
    assert_eq!(revoked["session"], "general");
    host.released(&open).await?;
    let reply = call.await.unwrap()?;
    assert!(reply.text.contains("navigation_denied"));
    s.finish().await
}

#[tokio::test]
async fn browser_usage_cancel_preserves_completed_batch_receipts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("BROWSER-USE-RECEIPTS")?.start().await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut host = Host::attach(admin.clone()).await?;
    host.snapshot(false).await?;
    let action_admin = admin.clone();
    let action = tokio::spawn(async move {
        action_admin.send(Method::POST,"/internal/browser/calls",Some(json!({"op":"tab.act","session":"general","tab":"fixture","call_id":"batch","args":{"steps":[{"action":"click"},{"action":"click"}]}})),&[]).await
    });
    let frame = host.dispatch().await?;
    let cancelled = admin.send(Method::POST,"/internal/browser/calls",Some(json!({"op":"tab.cancel","session":"general","tab":"fixture","args":{"call_id":"batch"}})),&[]).await?;
    assert_eq!(cancelled.status, 200);
    host.released(&frame).await?;
    assert!(
        !action.is_finished(),
        "release must retain the native result channel"
    );
    let receipts = json!({"status":"partial","steps":[{"status":"completed","still_file":"first.png"},{"status":"not_dispatched","reason":"cancelled"}]});
    host.result(&frame, receipts.clone()).await?;
    let reply = action.await.unwrap()?;
    let value: Value = serde_json::from_str(&reply.text).unwrap();
    assert_eq!(value["steps"], receipts["steps"]);
    s.finish().await
}
