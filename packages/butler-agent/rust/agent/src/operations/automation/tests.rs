use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};

use serde_json::{Map, Value, json};

use super::{AutomationDependencies, AutomationEnqueue, AutomationError, NativeAutomationService};

#[derive(Default)]
struct Queue(Mutex<Vec<Value>>, tokio::sync::Notify);

impl AutomationEnqueue for Queue {
    fn enqueue(&self, envelope: Value, _: Map<String, Value>) -> Result<(), AutomationError> {
        self.0.lock().unwrap().push(envelope);
        self.1.notify_one();
        Ok(())
    }
}

fn dependencies(now: Arc<AtomicI64>, queue: Arc<Queue>) -> AutomationDependencies {
    AutomationDependencies {
        parse_date: Arc::new(crate::js_date::parse_iso_millis),
        now_millis: Arc::new(move || now.load(Ordering::SeqCst)),
        enqueue: queue,
        scheduler_interval: Duration::from_secs(60),
    }
}

#[tokio::test(start_paused = true)]
async fn tool_claim_does_not_enqueue_and_scheduler_restart_does_not_duplicate() {
    let root = std::env::temp_dir().join(format!("native-automation-{}", uuid::Uuid::new_v4()));
    let now = Arc::new(AtomicI64::new(0));
    let queue = Arc::new(Queue::default());
    let service =
        NativeAutomationService::open(&root.clone(), dependencies(now.clone(), queue.clone()));

    service
        .execute(
            "create_automation",
            object(&json!({
                "id":"tool-claim", "prompt":"tool only", "schedule_type":"once",
                "run_at":"1970-01-01T00:00:01.000Z"
            })),
            "session-1",
        )
        .await
        .unwrap();
    let claimed = service
        .execute(
            "run_due_automations",
            object(&json!({
                "now":"1970-01-01T00:00:01.000Z"
            })),
            "session-1",
        )
        .await
        .unwrap();
    assert_eq!(claimed["claimed"], 1);
    assert!(queue.0.lock().unwrap().is_empty());

    service
        .execute(
            "create_automation",
            object(&json!({
                "id":"scheduled", "prompt":"scheduled", "schedule_type":"once",
                "run_at":"1970-01-01T00:00:02.000Z"
            })),
            "session-1",
        )
        .await
        .unwrap();
    now.store(2_000, Ordering::SeqCst);
    tokio::time::advance(Duration::from_secs(60)).await;
    queue.1.notified().await;
    // Closing joins the actor, including its admitted blocking scheduler work.
    service.close().await.unwrap();
    assert_eq!(queue.0.lock().unwrap().len(), 1);
    assert!(
        service
            .execute("list_automations", Map::new(), "session-1")
            .await
            .is_err()
    );

    let reopened = NativeAutomationService::open(&root.clone(), dependencies(now, queue.clone()));
    tokio::task::yield_now().await;
    assert_eq!(queue.0.lock().unwrap().len(), 1);
    reopened
        .execute(
            "delete_automation",
            object(&json!({"id":"scheduled"})),
            "session-1",
        )
        .await
        .unwrap();
    let listed = reopened
        .execute(
            "list_automations",
            object(&json!({"include_deleted":true})),
            "session-1",
        )
        .await
        .unwrap();
    assert!(
        listed["automations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| { item["id"] == "scheduled" && item["status"] == "deleted" })
    );
    reopened.close().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn offline_store_list_does_not_initialize_data() {
    let root =
        std::env::temp_dir().join(format!("native-automation-read-{}", uuid::Uuid::new_v4()));
    let store = super::store::AutomationStore::new(&root.clone());
    assert!(store.list(false).unwrap().is_empty());
    assert!(!root.join("automations").exists());
}

#[test]
fn concurrent_run_and_delete_preserve_any_successful_run_count() {
    use std::{sync::Barrier, thread};

    for _ in 0..16 {
        let root =
            std::env::temp_dir().join(format!("native-automation-race-{}", uuid::Uuid::new_v4()));
        let store = super::store::AutomationStore::new(&root.clone());
        store
            .create(
                &object(&json!({
                    "id":"race", "prompt":"tick", "schedule_type":"interval",
                    "interval_minutes":1
                })),
                "session-1",
                0,
                &crate::js_date::parse_iso_millis,
            )
            .unwrap();

        let barrier = Arc::new(Barrier::new(3));
        let run_store = super::store::AutomationStore::new(&root.clone());
        let run_barrier = barrier.clone();
        let run = thread::spawn(move || {
            run_barrier.wait();
            run_store.run_now("race", 1_000, &crate::js_date::parse_iso_millis)
        });
        let delete_store = super::store::AutomationStore::new(&root.clone());
        let delete_barrier = barrier.clone();
        let delete = thread::spawn(move || {
            delete_barrier.wait();
            delete_store.delete("race", 1_000)
        });
        barrier.wait();

        let run_succeeded = run.join().unwrap().is_ok();
        delete.join().unwrap().unwrap();
        let final_record = store.read("race").unwrap().unwrap();
        assert_eq!(final_record.status, "deleted");
        assert_eq!(final_record.run_count, u64::from(run_succeeded));
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().unwrap().clone()
}
