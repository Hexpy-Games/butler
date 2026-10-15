//! Use the product's own checker, including its mobile overflow diagnostics.
use butler_e2e::e2e::{HarnessError, scenario::Scenario, security::AdminClient};
use butler_runtime::outputs::{OutputStore, PublishRequest};
use reqwest::Method;
use serde_json::{Value, json};

pub(crate) fn admin(s: &Scenario) -> AdminClient {
    AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap())
}
pub(crate) async fn check(s: &Scenario, id: &str) -> Result<Value, HarnessError> {
    check_in(s, id, "general").await
}
async fn check_in(s: &Scenario, id: &str, chat: &str) -> Result<Value, HarnessError> {
    let reply = admin(s)
        .send(
            Method::POST,
            "/internal/browser/calls",
            Some(
                json!({"output_id":id,"session_id":chat,"viewport":"mobile","include_image":false}),
            ),
            &[],
        )
        .await?;
    if reply.status != 200 {
        return Ok(json!({"status":"unavailable","reason":"check_unavailable"}));
    }
    Ok(reply.body)
}
pub(crate) async fn output(s: &Scenario) -> Result<bool, HarnessError> {
    let id = probe(s).await?;
    let report = check(s, &id).await?;
    Ok(report["status"] == "ok" && report["errors"]["total"] == 0)
}
pub(crate) async fn probe(s: &Scenario) -> Result<String, HarnessError> {
    let data = s.sandbox.data.clone();
    let workspace = s.sandbox.workspace.clone();
    tokio::task::spawn_blocking(move || -> Result<String, HarnessError> {
        std::fs::write(
            workspace.join("preflight.html"),
            "<!doctype html><meta charset=utf-8><body><p>Ready</p>",
        )?;
        let (output, _) = OutputStore::new(&data).publish(PublishRequest {
            workspace,
            path: "preflight.html".into(),
            entry: None,
            title: "Preflight".into(),
            session_id: "general".into(),
            message_id: "preflight".into(),
            turn_id: "preflight".into(),
        })?;
        Ok(output.output_id)
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?
}
pub(crate) async fn image_input(s: &Scenario) -> Result<bool, HarnessError> {
    let catalog = s.gw.get("/model-catalog").await?;
    fn supported(v: &Value, model: &str) -> bool {
        match v {
            Value::Object(fields) => {
                let same = fields
                    .get("model_ref")
                    .or_else(|| fields.get("id"))
                    .and_then(Value::as_str)
                    == Some(model);
                (same
                    && (fields.get("image_input_support").and_then(Value::as_str)
                        == Some("supported")
                        || fields
                            .get("input_modalities")
                            .and_then(Value::as_array)
                            .is_some_and(|a| a.iter().any(|v| v == "image"))))
                    || fields.values().any(|v| supported(v, model))
            }
            Value::Array(values) => values.iter().any(|v| supported(v, model)),
            _ => false,
        }
    }
    Ok(catalog.status == 200 && supported(catalog.data(), &s.model.model))
}
pub(crate) async fn artifacts(s: &Scenario, record: &mut Value) -> Result<(), HarnessError> {
    let latest = record["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .rev()
        .filter(|row| row["name"] == "output_publish" && row["ok"] == true)
        .find_map(|row| row["output_id"].as_str().map(str::to_owned));
    record["file_checks"]["published"] = json!(latest.is_some());
    if let Some(id) = latest {
        let data = s.sandbox.data.clone();
        let output_id = id.clone();
        let session = tokio::task::spawn_blocking(move || -> Result<String, HarnessError> {
            Ok(OutputStore::new(&data).read(&output_id)?.session_id)
        })
        .await
        .map_err(|e| HarnessError(e.to_string()))??;
        let report = check_in(s, &id, &session).await?;
        record["output_check"] = report.clone();
        if record["case"] == "D2" {
            if report["status"] == "unavailable" {
                record["not_run_reason"] = json!("check_unavailable");
            }
            record["file_checks"]["dashboard"] = json!(
                report["errors"]["total"] == 0 && report["layout"]["overflow_px"]["mobile"] == 0
            );
            let data = s.sandbox.data.clone();
            let html = tokio::task::spawn_blocking(move || -> Result<String, HarnessError> {
                let store = OutputStore::new(&data);
                let output = store.read(&id)?;
                let revision = output.revisions.last().unwrap();
                let file = store.open_content(&id, revision.revision, &revision.entry)?;
                use std::io::Read;
                let mut text = String::new();
                let mut input = file;
                input.read_to_string(&mut text)?;
                Ok(text)
            })
            .await
            .map_err(|e| HarnessError(e.to_string()))??;
            record["file_checks"]["html"] = json!(html);
        }
    }
    Ok(())
}

/// Bind each fresh chat to its fixture workspace through the public project API.
pub(crate) async fn chat(s: &Scenario) -> Result<String, HarnessError> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let path = s
        .sandbox
        .data
        .join("state/app-gateway/project-folder-token-secret");
    let secret = tokio::task::spawn_blocking(move || std::fs::read_to_string(path))
        .await
        .map_err(|e| HarnessError(e.to_string()))??;
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(
        &json!({"path":s.sandbox.workspace,"expires_at":4_102_444_800_000_u64}),
    )?);
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.trim().as_bytes()).unwrap();
    mac.update(payload.as_bytes());
    let token = format!(
        "v1.{payload}.{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    let project =
        s.gw.post(
            "/projects",
            json!({"source":"existing_folder","folder_selection_token":token}),
        )
        .await?;
    assert_eq!(project.status, 201, "{}", project.text);
    let reply = s.gw.post("/sessions", json!({"kind":"project","project_id":project.data()["project"]["id"],"workspace_mode":"local"})).await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    Ok(reply.data()["session"]["id"].as_str().unwrap().to_owned())
}
