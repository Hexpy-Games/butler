//! Fresh workspace files and project-chat binding through the public gateway.
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::{Value, json};
use std::path::{Component, Path};

pub(super) fn files(root: &Path, case: &Value, first: bool) -> Result<(), HarnessError> {
    let base = json!({"README.md":"# Buttler\nA small example project.\n", "dram_prices.csv":"month,maker,price_usd\n2026-01,A,3.1\n2026-02,A,3.3\n2026-01,B,3.0\n2026-02,B,3.2\n",
        "docs/guide.md":"# Guide\nRead the documentation before deployment.\n", "draft.txt":"Draft for review.\n",
        "portfolio.csv":"symbol,sector,value\nAAA,technology,300\nBBB,healthcare,200\n",
        "src/user.py":"def fetchUser(uid):\n    return {'id': uid}\n", "src/login.py":"def redirect_after_login():\n    return '/home'\n",
        "reports/q3.md":"# Q3\nRevenue 120, expenses 80.\n",
        "meetings/01.md":"# Decisions\nLaunch July 15; owner Jimin.\n",
        "notes/a.md":"# 회의\n회의 준비를 해 주세요.\n", "notes/b.md":"# 배포\n테스트 후 배포합니다.\n", "notes/c.md":"# 일정\n금요일에 검토합니다.\n"});
    let workspace = if first { &base } else { &case["workspace"] };
    for (name, content) in workspace.as_object().into_iter().flatten() {
        let path = Path::new(name);
        if path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
            return Err(HarnessError("fixture path escapes workspace".into()));
        }
        let dest = root.join(path);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        std::fs::write(dest, content.as_str().unwrap())?;
    }
    Ok(())
}

struct Clock;
impl butler_turn::workspace::WorkspaceClock for Clock {
    fn now_epoch_millis(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
    fn parse_iso_millis(&self, value: &str) -> Option<i64> {
        butler_core::js_date::parse_iso_millis(value)
    }
    fn iso_from_epoch_millis(&self, value: i64) -> butler_turn::workspace::WorkspaceResult<String> {
        Ok(butler_core::js_date::format_iso_millis(value).unwrap())
    }
}

pub(super) async fn chat(s: &Scenario) -> Result<String, HarnessError> {
    use butler_turn::workspace::*;
    let reply =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Evaluation"}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let chat = reply.data()["session"]["id"].as_str().unwrap().to_owned();
    // Seed only the chat's workspace, without a setup model turn or project Ledger.
    // The real App ingress supplies transport, role policy and turn context.
    let bindings = SessionBindingStore::open(SessionBindingStoreConfig {
        path: session_store_path(&s.sandbox.data),
        storage_profile: WorkspaceStorageProfile::Durable,
        clock: std::sync::Arc::new(Clock),
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?;
    bindings
        .upsert(UpsertSessionBinding {
            session_id: butler_gateway::gateway::app_session_hint(&chat),
            role: SessionRole::Butler,
            project_id: None,
            app_project_id: OwnOptional::Null,
            ledger_project_id: OwnOptional::Null,
            workspace_path: s.sandbox.workspace.to_string_lossy().into_owned(),
            runtime_adapter_id: "btcc-turn-runtime".into(),
            model_provider_id: s.model.provider().into(),
            model_ref: s.model.model.clone(),
            runtime_session_ref: None,
            provider_thread_ref: None,
            transport_bindings: vec![],
            lifecycle_state: Some(SessionLifecycleState::Active),
            created_at: None,
            updated_at: None,
            last_active_at: None,
            metadata: None,
        })
        .await
        .map_err(|e| HarnessError(e.to_string()))?;
    Ok(chat)
}

pub(super) async fn workers(s: &Scenario) -> Result<(), HarnessError> {
    let settings = s.gw.get("/settings").await?;
    let mut profiles = settings.data()["worker_profiles"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert!(!profiles.is_empty(), "worker profiles are required");
    for profile in &mut profiles {
        profile["model"] = json!(s.model.model);
        profile["reasoning_effort"] = json!(s.model.effort.as_deref().unwrap_or("medium"));
    }
    s.patch_settings(
        json!({"worker_profiles":profiles}),
        "evaluation worker models",
    )
    .await?;
    Ok(())
}

/// Hosted API-key models need a registered connection as well as a saved key.
pub(super) async fn register_model(s: &Scenario, proxy: &str) -> Result<(), HarnessError> {
    let provider = s.model.provider();
    if provider == "openai" {
        return Ok(());
    }
    let credentials = s.gw.get("/credentials").await?;
    let id = credentials.data()["credentials"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|credential| credential["provider_id"] == provider)
        .map(|credential| credential["id"].clone())
        .ok_or_else(|| HarnessError("evaluation provider credential is not registered".into()))?;
    let model = s.model.model.split_once('/').unwrap().1;
    let registered =
        s.gw.post(
            "/model-catalog/registered-models",
            json!({
                "provider_id":provider,"model_id":model,"auth_type":"api_key","credential_id":id,
                "api_base_url":format!("{proxy}{}", butler_e2e::e2e::config::base_path(provider))
            }),
        )
        .await?;
    if registered.status != 201 {
        return Err(HarnessError(format!(
            "evaluation model registration failed: {}",
            registered.status
        )));
    }
    Ok(())
}
