//! PROJECT-REF-01: a composer `@` project reference reaches the agent as the
//! project's current name and folder, and stays in later conversation history.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use butler_e2e::e2e::{
    HarnessError,
    provider::Script,
    scenario::{Scenario, Setup},
};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{fs, path::Path, time::Duration};

const HEADER: &str = "Explicit user-selected project references";

async fn create_project(s: &Scenario, root: &Path, name: &str) -> Result<String, HarnessError> {
    let secret = fs::read_to_string(
        s.sandbox
            .data
            .join("state/app-gateway/project-folder-token-secret"),
    )?;
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(
        &json!({"path":root,"expires_at":4_102_444_800_000_u64}),
    )?);
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.trim().as_bytes()).unwrap();
    mac.update(payload.as_bytes());
    let token = format!(
        "v1.{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    let created =
        s.gw.post(
            "/projects",
            json!({"source":"existing_folder","display_name":name,"folder_selection_token":token}),
        )
        .await?;
    assert_eq!(created.status, 201, "{}", created.text);
    Ok(created.data()["project"]["id"].as_str().unwrap().to_owned())
}

fn prompt(request: &Value) -> String {
    let mut text = request["instructions"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    for item in request["input"].as_array().into_iter().flatten() {
        if let Some(content) = item["content"].as_str() {
            text.push_str(content);
        }
        for part in item["content"].as_array().into_iter().flatten() {
            if let Some(content) = part["text"].as_str() {
                text.push_str(content);
            }
        }
    }
    text
}

/// Sends to the general conversation and returns the prompt of the one model request it made.
async fn send(s: &Scenario, parts: Value) -> Result<String, HarnessError> {
    let turns = |s: &Scenario| -> Result<Vec<Value>, HarnessError> {
        Ok(s.provider()?
            .requests()
            .into_iter()
            .filter(|r| !butler_e2e::e2e::provider::is_title_request(r))
            .collect())
    };
    let before = turns(s)?.len();
    let reply =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general","client_message_id":uuid::Uuid::new_v4().to_string(),
                "content_parts":{"version":1,"parts":parts}}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let turn_id = s.gw.accepted_turn(reply.data()).await?;
    let turn =
        s.gw.wait_terminal("general", &turn_id, Duration::from_secs(120))
            .await?;
    assert_eq!(turn["state"], "delivered", "{turn}");
    let requests = turns(s)?;
    assert_eq!(requests.len(), before + 1);
    Ok(prompt(&requests[before]))
}

#[tokio::test]
async fn project_reference_reaches_the_agent() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("PROJECT-REF-01")?.synthetic(Script {
        rounds: 0,
        path_for: Box::new(|_| String::new()),
        final_text: "done".into(),
    });
    let root = setup.sandbox.workspace.clone();
    let s = setup.start().await?;
    let id = create_project(&s, &root, "Mention Atlas").await?;
    let renamed =
        s.gw.patch(
            &format!("/projects/{id}"),
            json!({"display_name":"Atlas Renamed"}),
        )
        .await?;
    assert_eq!(renamed.status, 200, "{}", renamed.text);

    let text = send(
        &s,
        json!([
            {"type":"text","text":"Summarize "},
            {"type":"project_ref","projectId":id,"titleSnapshot":"Mention Atlas"},
            {"type":"text","text":" and "},
            {"type":"project_ref","projectId":"project-gone","titleSnapshot":"Gone Project"},
            {"type":"project_ref","projectId":id,"titleSnapshot":"Mention Atlas"},
        ]),
    )
    .await?;
    let section = text
        .split_once(HEADER)
        .map(|(_, tail)| tail)
        .expect("project references section");
    let listed: Vec<Value> =
        serde_json::from_str(section.split_once('\n').unwrap().1.lines().next().unwrap())?;
    assert_eq!(listed.len(), 2, "each project once: {listed:?}");
    assert_eq!(listed[0]["projectId"], id.as_str());
    assert_eq!(listed[0]["status"], "available");
    assert_eq!(
        listed[0]["title"], "Atlas Renamed",
        "the current name, not the sent one"
    );
    let folder = Path::new(listed[0]["workspacePath"].as_str().unwrap());
    assert_eq!(folder.canonicalize()?, root.canonicalize()?);
    assert_eq!(
        listed[1],
        json!({"projectId":"project-gone","title":"Gone Project","status":"unavailable"})
    );
    assert!(
        text.contains("Summarize @Mention Atlas and @Gone Project@Mention Atlas"),
        "{text}"
    );

    let later = send(&s, json!([{"type":"text","text":"And now?"}])).await?;
    assert!(
        !later.contains(HEADER),
        "only the turn that referenced it: {later}"
    );
    assert!(
        later.contains("[user project references: "),
        "history keeps the reference: {later}"
    );

    let invalid =
        s.gw.post(
            "/messages",
            json!({"chat_id":"general","client_message_id":uuid::Uuid::new_v4().to_string(),
                "content_parts":{"version":1,"parts":[{"type":"project_ref","projectId":" ","titleSnapshot":"x"}]}}),
        )
        .await?;
    assert_eq!(invalid.status, 400, "{}", invalid.text);
    s.finish().await
}

/// PROJECT-REF-02: a client cannot supply project fields the server resolves, and an
/// archived project reads as unavailable, like a deleted one.
#[tokio::test]
async fn injected_fields_refused_and_archived_unavailable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("PROJECT-REF-02")?.synthetic(Script {
        rounds: 0,
        path_for: Box::new(|_| String::new()),
        final_text: "done".into(),
    });
    let root = setup.sandbox.workspace.clone();
    let s = setup.start().await?;
    let id = create_project(&s, &root, "Mention Atlas").await?;
    const INJECTED: &str = "/injected/.ssh";
    for extra in [
        json!({"workspacePath":INJECTED}),
        json!({"status":"available"}),
        json!({"title":"Other"}),
    ] {
        let mut part = json!({"type":"project_ref","projectId":id,"titleSnapshot":"Mention Atlas"});
        part.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let refused =
            s.gw.post(
                "/messages",
                json!({"chat_id":"general","client_message_id":uuid::Uuid::new_v4().to_string(),
                    "content_parts":{"version":1,"parts":[part]}}),
            )
            .await?;
        assert_eq!(refused.status, 400, "{extra}: {}", refused.text);
    }

    let first = send(
        &s,
        json!([{"type":"project_ref","projectId":id,"titleSnapshot":"Mention Atlas"}]),
    )
    .await?;
    assert!(!first.contains(INJECTED), "{first}");
    let archived =
        s.gw.patch(&format!("/projects/{id}"), json!({"archived":true}))
            .await?;
    assert_eq!(archived.status, 200, "{}", archived.text);
    let text = send(
        &s,
        json!([{"type":"project_ref","projectId":id,"titleSnapshot":"Mention Atlas"}]),
    )
    .await?;
    let section = text
        .split_once(HEADER)
        .map(|(_, tail)| tail)
        .expect("project references section");
    let listed: Vec<Value> =
        serde_json::from_str(section.split_once('\n').unwrap().1.lines().next().unwrap())?;
    assert_eq!(
        listed,
        vec![json!({"projectId":id,"title":"Mention Atlas","status":"unavailable"})],
        "an archived project gives no folder"
    );
    let history = text.split_once(HEADER).unwrap().0;
    assert!(
        history.contains("[user project references: ") && !history.contains("workspacePath"),
        "history shows only the id and sent name: {history}"
    );
    assert!(!text.contains(INJECTED), "{text}");
    s.finish().await
}
