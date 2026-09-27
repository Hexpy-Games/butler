use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Value, json};

use super::*;
use crate::host::{ProgressPublisher, SystemIdentity};
use butler_turn::btcc::{
    BtccRepositories, BtccStorage, Peer, PeerKind, ProgressDestination, ProgressEventRepository,
    ProgressWrite, RuntimeTurnEventInput, StorageProgressPublication, TestStorageFixture,
};

const SESSION: &str = "butler/app-general";

struct Harness {
    _fixture: TestStorageFixture,
    root: PathBuf,
    repositories: BtccRepositories,
    writer: Arc<TranscriptWriter>,
    progress: Arc<ProgressPublisher>,
}

impl Harness {
    async fn new(owner: &str) -> Self {
        let fixture = TestStorageFixture::activated();
        let storage = BtccStorage::open(fixture.config(owner)).await.unwrap();
        let root =
            std::env::temp_dir().join(format!("butler-app-delivery-{}", uuid::Uuid::new_v4()));
        let writer =
            Arc::new(TranscriptWriter::new(root.clone(), Arc::new(SystemIdentity)).unwrap());
        let progress = Arc::new(ProgressPublisher::new(
            StorageProgressPublication::new(storage.clone()),
            writer.clone(),
        ));
        Self {
            _fixture: fixture,
            root,
            repositories: BtccRepositories::new(storage, None),
            writer,
            progress,
        }
    }

    /// Commits one public progress event of `turn` the way a running Turn does.
    async fn commit(&self, turn: &str, note: &str) {
        let mut event = RuntimeTurnEventInput::new("assistant.public_note");
        event.payload = json!({"note":note,"interfaceLabelKey":"accepted"})
            .as_object()
            .cloned();
        self.repositories
            .append(ProgressWrite {
                session_id: SESSION.into(),
                turn_id: turn.into(),
                destination: ProgressDestination {
                    transport: "app".into(),
                    account_id: "local".into(),
                    peer: Peer {
                        kind: PeerKind::Dm,
                        id: "general".into(),
                        parent_id: None,
                    },
                    reply_to_message_id: "message".into(),
                    app_queue_claim_id: Some("claim".into()),
                },
                event,
            })
            .await
            .unwrap();
    }

    /// Outbound action ids in transcript order, after the writer drained.
    async fn outbound_actions(self) -> Vec<String> {
        self.writer.close().await.unwrap();
        let actions = outbound_actions(&self.root);
        let _ignored_cleanup = std::fs::remove_dir_all(&self.root);
        actions
    }
}

fn outbound_actions(root: &Path) -> Vec<String> {
    let file = root.join("transcripts").join("butler_app-general.jsonl");
    std::fs::read_to_string(file)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .filter(|event| event["kind"] == "outbound")
        .map(|event| event["payload"]["actionId"].as_str().unwrap().to_owned())
        .collect()
}

fn final_action(turn: &str) -> Value {
    json!({
        "actionId":format!("btcc-final:{turn}"),
        "transport":"app",
        "accountId":"local",
        "peer":{"kind":"dm","id":"general"},
        "message":{"text":"Done.","replyToMessageId":"message"},
        "metadata":{"kind":"final_result","turnId":turn,"appQueueClaimId":"claim"},
    })
}

/// App projection drops progress that reaches it after its Turn settled, so a
/// Turn's final result may enter the transcript only after every progress
/// event the Turn committed, whatever the periodic publisher has done so far.
#[tokio::test]
async fn committed_progress_enters_the_transcript_before_the_delivered_final() {
    let harness = Harness::new("app-delivery-order").await;
    harness.commit("turn", "Read the file.").await;
    harness.commit("turn", "Read the notes.").await;
    let delivery = AppDelivery::new(harness.writer.clone(), harness.progress.clone());

    let delivered = delivery
        .deliver(SESSION.into(), final_action("turn"))
        .await
        .unwrap();

    assert!(delivered);
    let summary = harness.progress.reconcile().await.unwrap();
    assert_eq!(summary.attempted, 0, "the delivery left progress pending");
    let actions = harness.outbound_actions().await;
    assert_eq!(actions.len(), 3, "{actions:?}");
    assert!(
        actions[..2]
            .iter()
            .all(|id| id.starts_with("btcc-progress-action:")),
        "{actions:?}"
    );
    assert_eq!(actions[2], "btcc-final:turn");
}

/// The periodic pass and a delivery's flush can overlap; each committed event
/// still enters the transcript exactly once.
#[tokio::test]
async fn overlapping_passes_publish_each_committed_event_once() {
    let harness = Harness::new("app-delivery-overlap").await;
    for index in 0..40 {
        harness.commit("turn", &format!("Step {index}.")).await;
    }

    let (first, second) = tokio::join!(harness.progress.reconcile(), harness.progress.reconcile());

    let published = first.unwrap().published + second.unwrap().published;
    assert_eq!(published, 40);
    let actions = harness.outbound_actions().await;
    let unique = actions
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len();
    assert_eq!((actions.len(), unique), (40, 40));
}
