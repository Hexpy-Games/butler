//! A scripted browser host on the real authenticated host stream.
use butler_e2e::e2e::{HarnessError, scenario::Scenario, security::AdminClient};
use futures_util::future::BoxFuture;
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub(super) type Respond = Arc<dyn Fn(Value) -> BoxFuture<'static, Value> + Send + Sync>;

pub(super) struct Host {
    pub frames: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Host {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(super) fn admin(s: &Scenario) -> AdminClient {
    AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap())
}

pub(super) async fn attach(s: &Scenario, respond: Respond) -> Result<Host, HarnessError> {
    let admin = admin(s);
    let mut stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let frames = Arc::new(Mutex::new(Vec::new()));
    let seen = frames.clone();
    let task = tokio::spawn(async move {
        let mut buffer = String::new();
        loop {
            let Ok(frame) =
                super::super::browser_delegation::next_frame(&mut stream, &mut buffer).await
            else {
                return;
            };
            seen.lock().unwrap().push(frame.clone());
            let op = frame["op"].as_str().unwrap_or("").to_owned();
            if op.starts_with("use.") {
                continue;
            }
            let id = frame["id"].as_str().unwrap_or("").to_owned();
            let result = respond(frame).await;
            let _ = admin
                .send(
                    Method::POST,
                    &format!("/internal/browser-host/results/{id}"),
                    Some(result),
                    &[],
                )
                .await;
        }
    });
    Ok(Host { frames, task })
}

impl Host {
    pub(super) fn ops(&self) -> Vec<String> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .map(|frame| frame["op"].as_str().unwrap_or("").to_owned())
            .collect()
    }
    pub(super) fn last(&self, op: &str) -> Option<Value> {
        self.frames
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|frame| frame["op"] == op)
            .cloned()
    }
}

/// Publishes the host's tab registry snapshot.
pub(super) async fn snapshot(admin: &AdminClient, tabs: Value) -> Result<(), HarnessError> {
    let reply = admin
        .send(
            Method::POST,
            "/internal/browser-host/events",
            Some(json!({"tabs": tabs})),
            &[],
        )
        .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(())
}

/// One agent-side tool-level call through the internal route.
pub(super) async fn call(
    admin: &AdminClient,
    session: &str,
    op: &str,
    tab: &str,
    args: Value,
) -> Result<Value, HarnessError> {
    call_turn(admin, session, op, tab, args, None).await
}

pub(super) async fn call_turn(
    admin: &AdminClient,
    session: &str,
    op: &str,
    tab: &str,
    args: Value,
    turn: Option<&str>,
) -> Result<Value, HarnessError> {
    let mut frame = json!({"op": op, "session": session, "tab": tab, "args": args});
    if let Some(turn) = turn {
        frame["turn_id"] = json!(turn);
    }
    let reply = admin
        .send(Method::POST, "/internal/browser/calls", Some(frame), &[])
        .await?;
    assert!(reply.status == 200, "{op}: {} {}", reply.status, reply.text);
    Ok(reply.body)
}

pub(super) fn tab(id: &str, owner: &str, url: &str, holder: &str) -> Value {
    json!({"id": id, "owner": owner, "profile": "signed_in", "epoch": 1, "holder": holder, "url": url})
}
