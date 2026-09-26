use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use super::repository_tests::prepared;
use super::{BtccRepositories, BtccStorage, TestStorageFixture};
use crate::btcc::{GuidedContinuationBudgetFactory, TurnContinuationBudgetLimits, TurnStore};

#[tokio::test]
async fn guided_budget_uses_real_claim_and_persists_once_without_retained_history() {
    let fixture = TestStorageFixture::activated();
    let limits = TurnContinuationBudgetLimits {
        max_model_requests: 5,
        max_tool_rounds: 5,
        max_model_facing_bytes: 100,
        max_cumulative_model_facing_bytes: 200,
        max_output_bytes: 10,
        max_elapsed_ms: 10_000,
        max_idle_ms: 10_000,
        extensions: Default::default(),
    };
    let storage = BtccStorage::open(fixture.config("guided-budget"))
        .await
        .unwrap();
    let repository = Arc::new(BtccRepositories::new(storage, Some(limits.clone())));
    let (turn, _) = repository
        .load_or_admit(&prepared("budget-turn", "budget-trigger", "budget-hash"))
        .await
        .unwrap();
    let claim = repository.acquire_state_claim(&turn).await.unwrap();
    let started = turn.continuation_budget.as_ref().unwrap()["startedAtMs"]
        .as_u64()
        .unwrap();
    let now = Arc::new(AtomicU64::new(started + 1));
    let clock = {
        let now = now.clone();
        Arc::new(move || now.fetch_add(1, Ordering::SeqCst))
    };
    let missing = GuidedContinuationBudgetFactory::new(None, clock.clone());
    assert_eq!(
        missing.bind(&turn, &claim).err().unwrap().code,
        "turn_continuation_dependency_missing"
    );
    let mut without_budget = turn.clone();
    without_budget.continuation_budget = None;
    assert!(missing.bind(&without_budget, &claim).unwrap().is_none());
    assert_eq!(now.load(Ordering::SeqCst), started + 1);

    let factory = GuidedContinuationBudgetFactory::new(Some(repository.clone()), clock);
    let budget = factory.bind(&turn, &claim).unwrap().unwrap();
    assert_eq!(budget.limits(), &limits);
    let final_owner = Arc::downgrade(&budget);
    let digest = "a".repeat(64);
    budget.admit_request("round-1", &digest, 30).await.unwrap();
    budget.admit_request("round-1", &digest, 30).await.unwrap();
    budget.admit_request("round-1", &digest, 50).await.unwrap();
    budget.record_output("round-1", 4).await.unwrap();
    budget.record_output("round-1", 4).await.unwrap();
    budget.record_tool_round("round-1").await.unwrap();
    budget.record_tool_round("round-1").await.unwrap();
    let persisted = repository
        .find_turn(&turn.turn_id)
        .await
        .unwrap()
        .unwrap()
        .continuation_budget
        .unwrap();
    assert_eq!(persisted["admittedRequests"].as_array().unwrap().len(), 1);
    assert_eq!(persisted["consumedModelFacingBytes"], 50);
    assert_eq!(persisted["consumedOutputBytes"], 4);
    assert_eq!(
        persisted["completedToolRounds"],
        serde_json::json!(["round-1"])
    );
    assert_eq!(
        persisted["completedOutputRounds"],
        serde_json::json!(["round-1"])
    );
    assert_eq!(now.load(Ordering::SeqCst), started + 8);

    let mut stale = turn.clone();
    stale.execution_fence += 1;
    let stale_budget = factory.bind(&stale, &claim).unwrap().unwrap();
    assert!(stale_budget.record_output("stale", 1).await.is_err());
    assert_eq!(
        repository
            .find_turn(&turn.turn_id)
            .await
            .unwrap()
            .unwrap()
            .continuation_budget
            .unwrap(),
        persisted
    );
    let exhausted = budget.record_output("round-2", 7).await.unwrap_err();
    assert_eq!(exhausted.code, "turn_continuation_budget_exhausted");
    let terminal = repository
        .find_turn(&turn.turn_id)
        .await
        .unwrap()
        .unwrap()
        .continuation_budget
        .unwrap();
    assert_eq!(terminal["terminal"]["reason"], "max_output_bytes");
    assert_eq!(terminal["consumedOutputBytes"], 11);
    drop(budget);
    assert!(final_owner.upgrade().is_none());
    // Dropping the Turn owner never closes the shared repository.
    repository.find_turn(&turn.turn_id).await.unwrap().unwrap();
    drop(stale_budget);
    drop(factory);
    repository.close().await.unwrap();
    drop(repository);

    let reopened = BtccStorage::open(fixture.config("guided-budget-reopen"))
        .await
        .unwrap();
    let reopened = BtccRepositories::new(reopened, None);
    assert_eq!(
        reopened
            .find_turn(&turn.turn_id)
            .await
            .unwrap()
            .unwrap()
            .continuation_budget
            .unwrap(),
        terminal
    );
    reopened.close().await.unwrap();
}
