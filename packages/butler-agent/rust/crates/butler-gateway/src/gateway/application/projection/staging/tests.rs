use rusqlite::Connection;
use serde_json::{Map, Value, json};

use super::{TranscriptEvent, claim_id_from_event, load, stage};
use crate::gateway::application::storage::{AppStorage, AppStorageError};

/// One send of a staged action, as its transcript `outbound` record carries it.
#[derive(Clone, Copy)]
struct Record {
    chat: &'static str,
    event_id: &'static str,
    timestamp: &'static str,
    /// The record's own delivery bookkeeping (top-level `metadata`).
    attempts: u64,
    /// Part of the action's payload.
    label: &'static str,
    /// `payload.metadata.appQueueClaimId`.
    claim: Option<&'static str>,
}

const FIRST: Record = Record {
    chat: "general",
    event_id: "outbound-first",
    timestamp: "2026-09-14T00:00:01.000Z",
    attempts: 1,
    label: "Reading source",
    claim: Some("claim-1"),
};

/// What staging a second send of the same action does.
#[derive(Clone, Copy, Debug)]
enum Outcome {
    /// Accepted; the staged row is the named record.
    Keeps(&'static str),
    /// Refused as an identity conflict; the first record stays staged.
    Conflict,
}

/// Format pin (REC-04): the identity of a staged outbound row in the App
/// database. A second send of a staged action is accepted when only its
/// transcript envelope differs (event id, timestamp, record metadata) and
/// keeps the first record, while a different payload (including a claim
/// added to a claimless row) or another chat is still an identity conflict.
/// A send under a new claim replaces the row.
// test-category: format-pin
#[tokio::test]
async fn a_resent_action_stages_as_itself_and_a_different_one_conflicts() {
    let cases: [(&str, Record, Record, Outcome); 5] = [
        (
            "re-sent with a new envelope",
            FIRST,
            Record {
                event_id: "outbound-resent",
                timestamp: "2026-09-14T00:00:09.000Z",
                attempts: 2,
                ..FIRST
            },
            Outcome::Keeps("outbound-first"),
        ),
        (
            "a different payload",
            FIRST,
            Record {
                event_id: "outbound-other-payload",
                label: "Writing notes",
                ..FIRST
            },
            Outcome::Conflict,
        ),
        (
            "a claim added to a claimless row",
            Record {
                claim: None,
                ..FIRST
            },
            Record {
                event_id: "outbound-claimed",
                ..FIRST
            },
            Outcome::Conflict,
        ),
        (
            "another chat",
            FIRST,
            Record {
                chat: "other",
                event_id: "outbound-other-chat",
                ..FIRST
            },
            Outcome::Conflict,
        ),
        (
            "a new claim",
            FIRST,
            Record {
                event_id: "outbound-reclaimed",
                claim: Some("claim-2"),
                ..FIRST
            },
            Outcome::Keeps("outbound-reclaimed"),
        ),
    ];
    let root = std::env::temp_dir().join(format!("butler-staging-identity-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let storage = AppStorage::open(
        root.join("app.sqlite"),
        None,
        "2026-09-14T00:00:00.000Z".into(),
    )
    .await
    .unwrap();
    let results = storage
        .execute(move |db| {
            let mut results = Vec::new();
            for (index, (name, first, second, outcome)) in cases.into_iter().enumerate() {
                let action = format!("action-{index}");
                stage_send(db, &action, first)?;
                let staged = stage_send(db, &action, second).map_err(|error| error.code());
                let kept = load(db, &action)?.map(|(chat, event)| (chat, event.event_id));
                results.push((name, first, outcome, staged, kept));
            }
            Ok(results)
        })
        .await
        .unwrap();
    for (name, first, outcome, staged, kept) in results {
        match outcome {
            Outcome::Keeps(event_id) => {
                assert_eq!(staged, Ok(()), "{name}");
                assert_eq!(
                    kept,
                    Some((first.chat.to_owned(), event_id.to_owned())),
                    "{name}"
                );
            }
            Outcome::Conflict => {
                assert_eq!(
                    staged,
                    Err("app_staged_outbound_identity_conflict"),
                    "{name}"
                );
                assert_eq!(
                    kept,
                    Some((first.chat.to_owned(), first.event_id.to_owned())),
                    "{name}: the first send stays staged"
                );
            }
        }
    }
    storage.close().await.unwrap();
    let _ = std::fs::remove_dir_all(root);
}

/// Stages `send` as the projection does for an outbound record.
fn stage_send(db: &Connection, action: &str, send: Record) -> Result<(), AppStorageError> {
    let event = outbound(action, send);
    let claim = claim_id_from_event(&event);
    stage(
        db,
        action,
        send.chat,
        &event,
        claim.as_deref(),
        "2026-09-14T00:00:10.000Z",
    )
}

fn outbound(action: &str, send: Record) -> TranscriptEvent {
    let mut metadata = json!({"kind": "tool_progress", "safeLabel": send.label});
    if let Some(claim) = send.claim {
        metadata["appQueueClaimId"] = json!(claim);
    }
    TranscriptEvent {
        event_id: send.event_id.to_owned(),
        session_id: "butler/app-general".to_owned(),
        kind: "outbound".to_owned(),
        timestamp: send.timestamp.to_owned(),
        payload: object(json!({"actionId": action, "message": {}, "metadata": metadata})),
        transport: Some("app".to_owned()),
        metadata: Some(object(json!({
            "source": "transport/delivery-guard.ts",
            "attempts": send.attempts,
        }))),
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        other => panic!("not an object: {other}"),
    }
}
