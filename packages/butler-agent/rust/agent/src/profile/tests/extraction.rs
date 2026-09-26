use std::collections::HashMap;

use rusqlite::OptionalExtension;
use serde_json::json;
use sha2::Digest;
use tokio_util::sync::CancellationToken;

use super::*;

mod import;
mod lifecycle;
mod native_provider;

#[tokio::test]
async fn canonical_discovery_claim_provider_and_commit_share_durable_coverage() {
    let root = Root::new("extraction");
    let message = CanonicalProfileMessage {
        id: "m1".into(),
        session_id: "s1".into(),
        role: "user".into(),
        origin_kind: "user_input".into(),
        created_at: "2023-11-14T22:13:20.000Z".into(),
        parts: vec![CanonicalProfilePart {
            part_id: "p1".into(),
            part_index: 0.0,
            scalars: vec![CanonicalProfileScalar {
                pointer: "/text".into(),
                source_hash: format!("{:x}", sha2::Sha256::digest(b"Please be concise")),
                text: "Please be concise".into(),
            }],
        }],
    };
    let (service, closed) = service(&root, HashMap::from([("m1".into(), message)]));
    service
        .set_profiling_mode(ProfilingMode::Basic)
        .await
        .unwrap();
    let result = service
        .capture_profile_candidates_from_transcripts_with_model(
            ProfileModelTranscriptCaptureOptions {
                cancellation: CancellationToken::new(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(result.scanned_file_count, 1);
    assert_eq!(result.scanned_event_count, 1);
    assert_eq!(result.captured_candidate_count, 1);
    assert!(result.model_called);
    assert_eq!(result.coverage_complete_count, Some(1));
    assert_eq!(result.coverage_pending_count, Some(0));
    assert_eq!(result.coverage_failed_count, Some(0));
    let db = storage::open(&root.0, false).unwrap();
    let candidate_count: i64 = db
        .query_row("SELECT COUNT(*) FROM profile_candidates", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(candidate_count, 1);
    let row = db.query_row("SELECT disposition,owner_pid,owner_nonce,claimed_at,failure_code FROM profile_source_coverage",[],|row|Ok(json!({"disposition":row.get::<_,String>(0)?,"owner_pid":row.get::<_,Option<f64>>(1)?,"owner_nonce":row.get::<_,Option<String>>(2)?,"claimed_at":row.get::<_,Option<String>>(3)?,"failure_code":row.get::<_,Option<String>>(4)?}))).optional().unwrap().unwrap();
    assert_eq!(
        row,
        json!({"disposition":"complete","owner_pid":null,"owner_nonce":null,"claimed_at":null,"failure_code":null})
    );
    assert!(closed.load(Ordering::SeqCst) >= 2);
    service.close().await;
}
