use std::sync::Arc;

use serde_json::{Value, json};

use super::NativeGuidedWorkTools;
use crate::btcc::{
    BtccRepositories, BtccStorage, DurableWorkService, ReviewVerdict, SessionWorkRepository,
    TestStorageFixture, TurnStore, WorkTurnScope, test_prepared_turn,
};

#[tokio::test]
async fn model_work_calls_create_reviewed_plan_in_canonical_store() {
    let fixture = TestStorageFixture::activated();
    let storage = BtccStorage::open(fixture.config("native-model-work-tools"))
        .await
        .unwrap();
    let repository = BtccRepositories::new(storage.clone(), None);
    let mut prepared = test_prepared_turn();
    prepared.command["context"] = json!({"messageContent":"Create a small file"});
    let (turn, _) = repository.load_or_admit(&prepared).await.unwrap();
    let service = Arc::new(DurableWorkService::new(Arc::new(
        SessionWorkRepository::new(storage.clone(), Arc::new(|| "now".into())),
    )));
    let owner = NativeGuidedWorkTools::new(
        service.clone(),
        WorkTurnScope {
            turn_id: turn.turn_id.clone(),
            session_id: turn.session_id.clone(),
            project_ref: None,
        },
    );
    let args = |value: Value| value.as_object().unwrap().clone();
    let started = owner
        .execute(
            &turn.turn_id,
            "start_work",
            &args(json!({"objective":"Create a small file"})),
            "work-call-1",
            &[],
            None,
        )
        .await
        .unwrap();
    assert_eq!(started["ok"], true, "{started}");
    let planned = owner
        .execute(
            &turn.turn_id,
            "replace_work_plan",
            &args(json!({"objective":"Create a small file", "execution_mode":"direct",
                "actions":[{"action_key":"Write the file","effect":{"capability":"write_file","target":"Create the requested workspace file"}}]})),
            "work-call-2",
            &[],
            None,
        )
        .await
        .unwrap();
    assert_eq!(planned["ok"], true, "{planned}");
    let reviewed = owner
        .execute(
            &turn.turn_id,
            "record_work_review",
            &args(
                json!({"subject":"plan","verdict":"accept","summary":"Plan matches the request",
                "action_updates":[{"action_key":"Write the file","status":"active"}]}),
            ),
            "work-call-3",
            &[],
            None,
        )
        .await
        .unwrap();
    assert_eq!(reviewed["ok"], true, "{reviewed}");
    let bound = service
        .bound_work_for_turn(turn.turn_id.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        bound.latest_plan_review.unwrap().verdict,
        ReviewVerdict::Accept
    );
    storage.close().await.unwrap();
}
