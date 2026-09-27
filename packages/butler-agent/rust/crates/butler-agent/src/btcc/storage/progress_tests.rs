use serde_json::json;

use super::repository::BtccRepositories;
use super::tests::Fixture;
use super::*;
use crate::btcc::{
    EventVisibility, Peer, PeerKind, ProgressDestination, ProgressEventRepository, ProgressWrite,
    RuntimeTurnEventInput,
};

#[tokio::test]
async fn duplicate_progress_keeps_sequence_and_first_destination_claim() {
    let fixture = Fixture::activated();
    let storage = BtccStorage::open(fixture.config("repository-progress"))
        .await
        .expect("open storage");
    let repositories = BtccRepositories::new(storage, None);
    let destination = ProgressDestination {
        transport: "app".into(),
        account_id: "account".into(),
        peer: Peer {
            kind: PeerKind::Dm,
            id: "peer".into(),
            parent_id: None,
        },
        reply_to_message_id: "message".into(),
        app_queue_claim_id: Some("claim-private".into()),
    };
    let mut event = RuntimeTurnEventInput::new("assistant.public_note");
    event.payload = json!({"note":"Request accepted.","interfaceLabelKey":"accepted"})
        .as_object()
        .cloned();
    let write = ProgressWrite {
        session_id: "session".into(),
        turn_id: "turn".into(),
        destination: destination.clone(),
        event,
    };
    repositories
        .append(write.clone())
        .await
        .expect("append progress");
    repositories.append(write).await.expect("idempotent append");
    let first = repositories
        .first_destination("turn")
        .await
        .expect("first destination")
        .expect("destination");
    assert_eq!(first.app_queue_claim_id.as_deref(), Some("claim-private"));
    let rows = repositories
        .storage
        .execute(|db| {
            db.query_row(
                "SELECT COUNT(*),MIN(turn_sequence),event_json FROM btcc_progress_events
            WHERE turn_id='turn'",
                [],
                |row| {
                    Ok((
                        row.get::<_, u64>(0)?,
                        row.get::<_, u64>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(StorageError::sqlite)
        })
        .await
        .expect("inspect progress");
    assert_eq!((rows.0, rows.1), (1, 1));
    let stored: serde_json::Value = serde_json::from_str(&rows.2).expect("event json");
    assert!(
        stored["createdAt"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_eq!(stored["visibility"], "public");

    let mut second = RuntimeTurnEventInput::new("turn.completed");
    second.created_at = Some("fixed".into());
    second.visibility = Some(EventVisibility::Internal);
    repositories
        .append(ProgressWrite {
            session_id: "session".into(),
            turn_id: "turn".into(),
            destination,
            event: second,
        })
        .await
        .expect("append explicit defaults");
    let explicit = repositories
        .storage
        .execute(|db| {
            db.query_row(
        "SELECT event_json FROM btcc_progress_events WHERE turn_id='turn' AND turn_sequence=2",[],
        |row|row.get::<_,String>(0)).map_err(StorageError::sqlite)
        })
        .await
        .expect("explicit event");
    let explicit: serde_json::Value = serde_json::from_str(&explicit).expect("explicit json");
    assert_eq!(explicit["createdAt"], "fixed");
    assert_eq!(explicit["visibility"], "internal");
    repositories.close().await.expect("close repository");
}
