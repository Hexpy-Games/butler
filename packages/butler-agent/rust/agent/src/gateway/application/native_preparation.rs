//! Rebuild native App input from the claimed durable App snapshot.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::*;
use crate::btcc::ExecutionControls;
use crate::gateway::MessageContentPart;

impl AppApplication {
    pub(super) async fn prepare_claimed_native(
        &self,
        claim: &QueueClaim,
    ) -> Result<NativeAppTurn, GatewayApplicationError> {
        let queued_id = claim.queued_message_id.clone();
        let claim_id = claim.claim_id.clone();
        let snapshot = self
            .storage
            .execute(move |db| claimed_snapshot(db, &queued_id, &claim_id))
            .await
            .map_err(app_error)?;
        let controls: ExecutionControls =
            serde_json::from_value(snapshot.execution_controls.clone()).map_err(|_| {
                public(
                    500,
                    "turn_execution_controls_invalid",
                    "Turn controls are unavailable.",
                )
            })?;
        let verified = controls.verify().map_err(|_| {
            public(
                500,
                "turn_execution_controls_invalid",
                "Turn controls are unavailable.",
            )
        })?;
        if verified.turn_id != snapshot.turn_id || verified.session_id != snapshot.chat_id {
            return Err(public(
                500,
                "turn_execution_controls_identity_mismatch",
                "Turn controls are unavailable.",
            ));
        }
        let needs_project_sources = snapshot
            .content_parts
            .as_ref()
            .and_then(|parts| serde_json::to_value(parts).ok())
            .and_then(|value| value.get("parts").cloned())
            .and_then(|value| value.as_array().cloned())
            .is_some_and(|parts| {
                parts.iter().any(|part| {
                    part.get("type").and_then(Value::as_str) == Some("project_source_ref")
                })
            });
        if needs_project_sources
            && snapshot
                .project_sources
                .as_array()
                .is_none_or(Vec::is_empty)
        {
            return Err(public(
                500,
                "project_source_snapshot_missing",
                "Project source context is unavailable.",
            ));
        }
        let readiness = self.dependencies.executor_readiness.readiness()?;
        if !readiness.authenticated_gateway_ready || !readiness.btcc_executor_ready {
            return Err(public(
                503,
                "app_transport_executor_unavailable",
                "The Butler runtime is unavailable.",
            ));
        }
        let assets = self
            .dependencies
            .native_assets
            .resolve(snapshot.clone())
            .await?;
        Ok(native_turn(snapshot, assets))
    }
}

fn claimed_snapshot(
    db: &Connection,
    queued_id: &str,
    claim_id: &str,
) -> Result<ClaimedNativeSnapshot, AppStorageError> {
    let mut snapshot = db
        .query_row(
            "SELECT q.chat_id,q.turn_id,q.dispatched_message_id,t.attempt,q.text,m.created_at,\
         t.execution_controls_json,q.project_source_refs_json,m.content_parts_json,\
         q.control_resolution_json,c.kind,c.project_id,p.workspace_path,p.ledger_project_id,\
         b.seed_json,q.attachments_json FROM session_queued_messages q \
         JOIN turns t ON t.id=q.turn_id JOIN messages m ON m.id=q.dispatched_message_id \
         JOIN chats c ON c.id=q.chat_id LEFT JOIN projects p ON p.id=c.project_id \
         LEFT JOIN app_session_branches b ON b.target_session_id=c.id AND b.state='ready' \
         WHERE q.id=?1 AND q.state='dispatching' AND q.claim_id=?2",
            params![queued_id, claim_id],
            |row| {
                let chat_id: String = row.get(0)?;
                let controls_json: String = row.get(6)?;
                let sources_json: String = row.get(7)?;
                let content_json: Option<String> = row.get(8)?;
                let resolution_json: Option<String> = row.get(9)?;
                let attachments_json: String = row.get(15)?;
                let project_id: Option<String> = row.get(11)?;
                let workspace_path: Option<String> = row.get(12)?;
                let ledger_project_id: Option<String> = row.get(13)?;
                let resolution = parse_value(resolution_json.as_deref().unwrap_or("{}"), 9)?;
                Ok(ClaimedNativeSnapshot {
                    session_id: session_hint(&chat_id),
                    chat_id,
                    turn_id: required(row.get(1)?, 1)?,
                    message_id: required(row.get(2)?, 2)?,
                    turn_attempt: row.get(3)?,
                    text: row.get(4)?,
                    timestamp: row.get(5)?,
                    execution_controls: parse_value(&controls_json, 6)?,
                    app_queue_claim_id: Some(claim_id.to_owned()),
                    session_kind: row.get(10)?,
                    project: project_id.map(|id| NativeProjectSnapshot {
                        id,
                        workspace_path: workspace_path.unwrap_or_default(),
                        ledger_project_id,
                    }),
                    branch_seed: row
                        .get::<_, Option<String>>(14)?
                        .map(|value| parse_value(&value, 14))
                        .transpose()?,
                    project_sources: parse_value(&sources_json, 7)?,
                    content_parts: content_json
                        .map(|value| parse_json(&value, 8))
                        .transpose()?,
                    authority_request_ref: string_field(&resolution, "authority_request_ref"),
                    plan_id: string_field(&resolution, "plan_id"),
                    attached_files: Vec::new(),
                    queue_attachments: parse_value(&attachments_json, 15)?,
                    reference_chats: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(AppStorageError::sqlite)?
        .ok_or_else(|| {
            AppStorageError::new(
                "queued_message_claim_lost",
                "Queued message claim was lost.",
            )
        })?;
    let mut attached = db
        .prepare(
            "SELECT f.id,f.owner_session_id,f.message_id,f.kind,f.mime_type,f.safe_name,\
         f.size_bytes,f.sha256,f.storage_name,f.created_at FROM message_attachments a \
         JOIN message_files f ON f.id=a.file_id WHERE a.message_id=?1 ORDER BY a.position",
        )
        .map_err(AppStorageError::sqlite)?;
    snapshot.attached_files = attached
        .query_map([&snapshot.message_id], |row| {
            Ok(AppMessageFileSnapshot {
                id: row.get(0)?,
                owner_session_id: row.get(1)?,
                message_id: row.get(2)?,
                kind: row.get(3)?,
                mime_type: row.get(4)?,
                safe_name: row.get(5)?,
                size_bytes: row.get(6)?,
                sha256: row.get(7)?,
                storage_name: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(AppStorageError::sqlite)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(AppStorageError::sqlite)?;
    let mut seen = HashSet::new();
    if let Some(content) = &snapshot.content_parts {
        for part in &content.parts {
            if let MessageContentPart::SessionRef { session_id, .. } = part {
                if !seen.insert(session_id) {
                    continue;
                }
                let chat = db
                    .query_row(
                        "SELECT id,title FROM chats WHERE id=?1",
                        [session_id],
                        |row| {
                            Ok(AppReferencedChatSnapshot {
                                id: row.get(0)?,
                                title: row.get(1)?,
                            })
                        },
                    )
                    .optional()
                    .map_err(AppStorageError::sqlite)?;
                if let Some(chat) = chat {
                    snapshot.reference_chats.push(chat);
                }
            }
        }
    }
    Ok(snapshot)
}

fn native_turn(snapshot: ClaimedNativeSnapshot, assets: ResolvedNativeAssets) -> NativeAppTurn {
    let mut context = Map::new();
    context.insert("version".into(), Value::from(1));
    if let Some(seed) = snapshot.branch_seed.clone() {
        context.insert("branchSeed".into(), seed);
    }
    context.insert("projectSources".into(), snapshot.project_sources.clone());
    if let Some(parts) = snapshot.content_parts.as_ref() {
        context.insert("contentParts".into(), json!(parts));
    }
    context.insert("sessionReferences".into(), assets.session_references);
    context.insert(
        "session".into(),
        json!({"id":snapshot.chat_id,"kind":if snapshot.session_kind=="project"{"project"}else{"chat"}}),
    );
    context.insert(
        "conversation".into(),
        json!({"chatId":snapshot.chat_id,"userMessageId":snapshot.message_id,
            "turnId":snapshot.turn_id,"turnAttempt":snapshot.turn_attempt}),
    );
    if let Some(project) = snapshot.project.as_ref() {
        let mut value = json!({"id":project.id,"workspacePath":project.workspace_path});
        if let Some(id) = project.ledger_project_id.as_ref() {
            value["ledgerProjectId"] = Value::String(id.clone());
        }
        context.insert("project".into(), value);
    }
    context.insert(
        "model".into(),
        json!({"requestedModelRef":snapshot.execution_controls.get("model_ref"),
            "reasoningEffort":snapshot.execution_controls.get("reasoning_effort")}),
    );
    if let Some(value) = snapshot.authority_request_ref.as_ref() {
        context.insert("authorityRequestRef".into(), value.clone().into());
        context.insert(
            "authorityClientMessageId".into(),
            snapshot.message_id.clone().into(),
        );
    }
    if let Some(value) = snapshot.plan_id.as_ref() {
        context.insert("planId".into(), value.clone().into());
    }
    NativeAppTurn {
        chat_id: snapshot.chat_id,
        message_id: snapshot.message_id,
        turn_id: snapshot.turn_id,
        turn_attempt: snapshot.turn_attempt,
        text: snapshot.text,
        timestamp: snapshot.timestamp,
        session_id: snapshot.session_id,
        account_id: "local".into(),
        peer_kind: "dm".into(),
        sender_id: "app-user".into(),
        sender_display_name: "Butler App".into(),
        project_id: snapshot.project.map(|project| project.id),
        execution_controls: snapshot.execution_controls,
        app_queue_claim_id: snapshot.app_queue_claim_id,
        app_turn_context: Value::Object(context),
        attachments: assets.attachments,
        image_admission: assets.image_admission,
        raw_source: "app-server".into(),
    }
}

pub(super) fn session_hint(chat_id: &str) -> String {
    let mut normalized = String::new();
    let mut separator = false;
    for ch in crate::public_text::trim_js_whitespace(chat_id)
        .to_lowercase()
        .chars()
    {
        if ch.is_ascii_alphanumeric() || "._-".contains(ch) {
            normalized.push(ch);
            separator = false;
        } else if !separator {
            normalized.push('-');
            separator = true;
        }
    }
    format!(
        "butler/app-{}",
        if normalized.is_empty() {
            "session"
        } else {
            &normalized
        }
    )
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}
fn required(value: Option<String>, column: usize) -> rusqlite::Result<String> {
    value.ok_or(rusqlite::Error::InvalidColumnType(
        column,
        "required durable identity".into(),
        rusqlite::types::Type::Null,
    ))
}
fn parse_value(value: &str, column: usize) -> rusqlite::Result<Value> {
    parse_json(value, column)
}
fn parse_json<T: serde::de::DeserializeOwned>(value: &str, column: usize) -> rusqlite::Result<T> {
    serde_json::from_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}
