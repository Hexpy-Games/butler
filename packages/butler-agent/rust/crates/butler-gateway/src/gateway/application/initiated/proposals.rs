//! Gateway-owned schedule creation after the user's proposal decision.
use super::super::{
    AppApplication, AppMemoryCommand, GatewayApplicationError, app_error, events, public,
};
use super::outbox;
use rusqlite::OptionalExtension;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

impl AppApplication {
    pub(in crate::gateway::application) async fn collect_proposals(
        &self,
    ) -> Result<(), GatewayApplicationError> {
        let view = self
            .dependencies
            .memory_management
            .execute(
                AppMemoryCommand::PatternProposals,
                self.memory_event_sink(),
                CancellationToken::new(),
            )
            .await?;
        let Some(bundles) = view["bundles"].as_array() else {
            return Ok(());
        };
        if bundles.is_empty() {
            return Ok(());
        }
        let bundles = bundles.clone();
        let language = self.briefing_language().await?;
        let clock = self.dependencies.identity_clock.clone();
        self.storage
            .execute(move |db| {
                for bundle in bundles {
                    let Some(id) = bundle["id"].as_str() else {
                        continue;
                    };
                    let candidates = bundle["candidates"].as_array().cloned().unwrap_or_default();
                    if !candidates.iter().any(|c| c["state"] == "pending") {
                        continue;
                    }
                    let text = match (language.as_str(), candidates.len()) {
                        ("ko", _) => "자주 찾으시는 걸 미리 준비해 둘까요?",
                        (_, 1) => "Want me to get this ready before you ask?",
                        _ => "Want me to get these ready before you ask?",
                    };
                    let mut panel =
                        json!({"kind":"pattern_proposal","bundle_id":id,"candidates":candidates});
                    redact(&mut panel);
                    outbox::enqueue(
                        db,
                        (&clock.new_uuid(), "general"),
                        &format!("pattern-bundle:{id}"),
                        "pattern_proposal",
                        text,
                        &json!({"panel":panel}),
                        &clock.now_iso(),
                    )?;
                }
                Ok(())
            })
            .await
            .map_err(app_error)?;
        self.automation_wake.notify_one();
        Ok(())
    }

    pub(in crate::gateway::application) async fn decide_proposal(
        &self,
        bundle_id: String,
        pattern_id: String,
        decision: String,
        revision: u64,
        cancellation: CancellationToken,
    ) -> Result<Value, GatewayApplicationError> {
        let _decision = self.initiated_decisions.lock().await;
        let port = &self.dependencies.memory_management;
        let view = port
            .execute(
                AppMemoryCommand::PatternProposals,
                self.memory_event_sink(),
                cancellation.clone(),
            )
            .await?;
        let candidate = candidate(&view, &bundle_id, &pattern_id)?;
        if view["revision"].as_u64() != Some(revision) || candidate["state"] != "pending" {
            return Err(public(
                409,
                "pattern_conflict",
                "This suggestion was already handled.",
            ));
        }
        let automation = if decision == "accepted" {
            Some(self.create_proposal_schedule(candidate).await?)
        } else {
            None
        };
        let result = port
            .execute(
                AppMemoryCommand::DecidePattern {
                    bundle_id: bundle_id.clone(),
                    pattern_id: pattern_id.clone(),
                    decision: decision.clone(),
                    expected_revision: revision,
                },
                self.memory_event_sink(),
                cancellation,
            )
            .await;
        let mut response = match result {
            Ok(response) => response,
            Err(error) => {
                if let Some(id) = automation {
                    self.delete_automation_owned(id).await?;
                }
                return Err(error);
            }
        };
        self.update_proposal_panel(bundle_id, pattern_id, decision, automation.clone())
            .await?;
        if let Some(id) = automation {
            response["automation_id"] = json!(id);
        }
        Ok(response)
    }

    async fn create_proposal_schedule(
        &self,
        candidate: &Value,
    ) -> Result<String, GatewayApplicationError> {
        let action = &candidate["action"];
        let weekdays = action["schedule"]["type"] == "weekdays";
        let gate = self.initiated_gate().await?;
        let input = serde_json::from_value(json!({"title":action["title"], "prompt_body":action["prompt"],
            "target_session_id":"general", "schedule":{"kind":if weekdays {"weekly"} else {"daily"},
            "time":action["schedule"]["time"], "weekdays":if weekdays {vec![1,2,3,4,5]} else {vec![]}, "tz":gate.tz}}))
            .map_err(GatewayApplicationError::internal_from)?;
        let result = self.create_automation_owned(input).await?;
        result.automation["id"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(GatewayApplicationError::internal)
    }

    async fn update_proposal_panel(
        &self,
        bundle: String,
        pattern: String,
        decision: String,
        automation: Option<String>,
    ) -> Result<(), GatewayApplicationError> {
        let now = self.dependencies.identity_clock.now_iso();
        let subscribers = self.subscribers.clone();
        self.storage
            .execute(move |db| {
                let tx = db
                    .savepoint()
                    .map_err(super::super::AppStorageError::sqlite)?;
                let source = format!("pattern-bundle:{bundle}");
                let stored: Option<String> = tx
                    .query_row(
                        "SELECT payload_json FROM app_initiated_messages WHERE source_key=?1",
                        [&source],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(super::super::AppStorageError::sqlite)?;
                if let Some(stored) = stored {
                    let mut payload: Value =
                        serde_json::from_str(&stored).map_err(outbox::json_error)?;
                    if let Some(candidates) = payload["panel"]["candidates"].as_array_mut() {
                        for candidate in
                            candidates.iter_mut().filter(|c| c["pattern_id"] == pattern)
                        {
                            candidate["state"] = json!(decision);
                            if let Some(id) = &automation {
                                candidate["automation_id"] = json!(id);
                            }
                        }
                    }
                    let event = outbox::update_payload(&tx, &source, &payload, &now)?;
                    tx.commit().map_err(super::super::AppStorageError::sqlite)?;
                    if let Some(event) = event {
                        events::publish(&subscribers, &event);
                    }
                }
                Ok(())
            })
            .await
            .map_err(app_error)
    }
}

fn candidate<'a>(
    view: &'a Value,
    bundle: &str,
    pattern: &str,
) -> Result<&'a Value, GatewayApplicationError> {
    view["bundles"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|b| b["id"] == bundle)
        .and_then(|b| b["candidates"].as_array())
        .into_iter()
        .flatten()
        .find(|c| c["pattern_id"] == pattern)
        .ok_or_else(|| public(404, "pattern_not_found", "Pattern not found."))
}
fn redact(panel: &mut Value) {
    if let Some(candidates) = panel["candidates"].as_array_mut() {
        for candidate in candidates {
            if let Some(action) = candidate["action"].as_object_mut() {
                action.remove("prompt");
            }
        }
    }
}

pub(in crate::gateway::application) fn public_proposals(view: &mut Value) {
    if let Some(bundles) = view["bundles"].as_array_mut() {
        for bundle in bundles {
            redact(bundle);
        }
    }
}
