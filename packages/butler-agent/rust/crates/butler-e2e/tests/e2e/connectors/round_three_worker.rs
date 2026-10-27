use super::round_two_access::attended;
use super::*;
use crate::worker_cap::{self, stub as worker};
use butler_e2e::e2e::scenario::Access;
use std::sync::atomic::Ordering;

async fn worker_direction(
    tainted: bool,
    unattended: bool,
    user_resteer: bool,
) -> Result<(), HarnessError> {
    let (url, script, server) = worker::start(4).await?;
    script.steer.store(true, Ordering::SeqCst);
    script.followup.store(true, Ordering::SeqCst);
    let setup = setup("PC3-WORKER-DIRECTION")?
        .access(Access::FullAccess)
        .env("BUTLER_CHATGPT_API_BASE_URL", url);
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    s.patch_settings(json!({"max_simultaneous_workers":2}), "worker limit")
        .await?;
    s.gw.say("general", "Verify batch red").await?;
    let (_, rows) = worker_cap::workers(&s, "general", 3).await?;
    worker_cap::started(&script, 2).await;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let relation = view.data()["steward_children"][0]["relation"]["relation_id"]
        .as_str()
        .unwrap();
    let spec = json!({"name":"steer_steward","arguments":{"relation_id":relation,"instruction":"Verify the updated source"}});
    if unattended {
        install(&s, &root).await?;
        let id = connect(&s, "immediate", 10.0).await?;
        account(&s, &id, "connected").await?;
        let mut injected = event("worker-direction");
        injected["snippet"] = format!("fixture-call:{spec}").into();
        emit(&s, &id, vec![injected]).await?;
        count(&s, "SELECT count(*) FROM turns WHERE state='delivered'", 2).await?;
    } else if tainted {
        let turn = attended(&s, spec).await?;
        assert_eq!(turn["state"], "delivered", "{turn}");
    } else {
        invoke(&s, "steer_steward", spec["arguments"].clone()).await?;
    }
    if user_resteer {
        let arguments =
            json!({"relation_id":relation,"instruction":"Verify the updated source from the user"});
        invoke(&s, "steer_steward", arguments).await?;
    }
    script.direction.add_permits(1);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !script.steered.load(Ordering::SeqCst) {
        assert!(Instant::now() < deadline, "worker was not steered");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    script.release("red-0");
    if tainted {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let cards = s.gw.approval_requests("general").await?;
            let asked = cards
                .iter()
                .any(|c| c.to_string().contains("replace_work_plan"));
            let refused = script.requests.lock().unwrap().iter().any(|(role, r)| {
                role == "worker" && r.to_string().contains("schedule_permission_required")
            });
            assert!(
                !user_resteer || !refused,
                "attended user steering was refused with schedule_permission_required"
            );
            if ((!unattended || user_resteer) && asked) || (unattended && !user_resteer && refused)
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "worker lost connector provenance"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    } else {
        worker_cap::closed(&s, rows[0]["session_id"].as_str().unwrap()).await?;
        assert_eq!(
            s.gw.approval_requests("general").await?,
            Vec::<Value>::new()
        );
    }
    if user_resteer {
        let runtime = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        let run: String = runtime.query_row(
            "SELECT instruction_run_context_json FROM btcc_subsession_delegations WHERE relation_id=?1",
            [relation], |r| r.get(0),
        )?;
        let run: Value = serde_json::from_str(&run)?;
        assert_eq!(run["connector_event"], true);
        assert_eq!(run["unattended"], false);
        assert_eq!(run["automation_id"], "");
        assert_eq!(run["run_id"], "");
        assert!(run["scheduled_at"].is_null());
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn round_three_connector_worker_attended() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    worker_direction(true, false, false).await
}
#[tokio::test]
async fn round_three_connector_worker_unattended() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    worker_direction(true, true, false).await
}
#[tokio::test]
async fn round_three_clean_worker_direction() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    worker_direction(false, false, false).await
}

#[tokio::test]
async fn round_four_user_resteer_worker_restores_attendance_keeps_connector_taint()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    worker_direction(true, true, true).await
}
