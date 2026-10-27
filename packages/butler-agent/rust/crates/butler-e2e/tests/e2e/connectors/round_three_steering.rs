use super::round_two_access::attended;
use super::*;
use crate::steward_presentation::stub as child;
use butler_e2e::e2e::scenario::Access;

async fn steer(tainted: bool, unattended: bool) -> Result<(), HarnessError> {
    let (url, script, server) = child::start().await?;
    let setup = setup("PC3-STEERING")?
        .access(Access::FullAccess)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"));
    for name in ["a.txt", "b.txt"] {
        fs::write(setup.sandbox.data.join(name), name)?;
    }
    *script.workspace.lock().unwrap() = setup.sandbox.data.display().to_string();
    let output = setup.sandbox.data.join("outward.txt");
    *script.direction_effect.lock().unwrap() = Some(
        json!({"command":"echo sent > outward.txt","cwd":setup.sandbox.data,"summary":"Send connected data","state_effect":"remote_observation"}),
    );
    let root = package(&setup.sandbox.home, false)?;
    let mut s = setup.start().await?;
    let (_, first) = s.turn("general", child::OWNER).await?;
    assert_eq!(first["state"], "delivered", "{first}");
    tokio::time::timeout(Duration::from_secs(30), script.held.notified())
        .await
        .map_err(|_| HarnessError("child did not reach held model round".into()))?;
    let view = s.gw.get("/session-view?session_id=general").await?;
    let relation = view.data()["steward_children"][0]["relation"]["relation_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let spec = json!({"name":"steer_steward","arguments":{"relation_id":relation,"instruction":"Use the new source data"}});
    if unattended {
        install(&s, &root).await?;
        let id = connect(&s, "immediate", 10.0).await?;
        account(&s, &id, "connected").await?;
        let mut injected = event("steering-injection");
        injected["snippet"] = format!("fixture-call:{spec}").into();
        emit(&s, &id, vec![injected]).await?;
    } else if tainted {
        let turn = attended(&s, spec).await?;
        assert_eq!(
            turn["state"], "delivered",
            "steering must remain allowed: {turn}"
        );
    } else {
        invoke(&s, "steer_steward", spec["arguments"].clone()).await?;
    }
    let runtime = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let n: i64 = runtime.query_row(
            "SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1",
            [&relation],
            |r| r.get(0),
        )?;
        if n == 1 {
            break;
        }
        assert!(Instant::now() < deadline, "steering did not reach child");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    script.release.notify_one();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let cards = s.gw.approval_requests("general").await?;
        let asked = cards.iter().any(|c| c.to_string().contains("run_command"));
        let refused = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.to_string().contains("schedule_permission_required"));
        if (tainted && !unattended && asked)
            || (unattended && refused)
            || (!tainted && output.exists())
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "child lost instruction provenance; effect executed={}",
            output.exists()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if tainted {
        assert!(
            !output.exists(),
            "child executed outward effect without approval"
        );
    }
    if tainted {
        let run: String = runtime.query_row(
            "SELECT instruction_run_context_json FROM btcc_subsession_delegations WHERE relation_id=?1",
            [&relation],
            |r| r.get(0),
        )?;
        assert_eq!(
            serde_json::from_str::<Value>(&run)?["connector_event"],
            true
        );
    }
    drop(runtime);
    if tainted && !unattended {
        let cards = s.gw.approval_requests("general").await?;
        let reference = cards
            .iter()
            .find(|c| c.to_string().contains("run_command"))
            .unwrap()["request_ref"]
            .as_str()
            .unwrap()
            .to_owned();
        s.restart().await?;
        assert!(!output.exists(), "restart executed the pending command");
        assert!(
            s.gw.approval_requests("general")
                .await?
                .iter()
                .any(|c| c["request_ref"] == reference)
        );
        let allowed =
            s.gw.post(
                &format!("/authority-requests/{reference}/allow?session_id=general"),
                json!({"scope":"once"}),
            )
            .await?;
        assert_eq!(allowed.status, 202, "{allowed:?}");
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let cards = s.gw.approval_requests("general").await?;
            if cards.iter().any(|c| c.to_string().contains("write_file")) {
                break;
            }
            for card in cards {
                let tool = card["approval"]["operation"]["tool"].as_str().unwrap();
                assert_eq!(
                    tool, "record_work_review",
                    "unexpected continuation approval: {card}"
                );
                let reference = card["request_ref"].as_str().unwrap();
                let allowed =
                    s.gw.post(
                        &format!("/authority-requests/{reference}/allow?session_id=general"),
                        json!({"scope":"once"}),
                    )
                    .await?;
                assert_eq!(allowed.status, 202);
            }
            assert!(
                Instant::now() < deadline,
                "continuation lost connector taint"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(output.exists(), "approved command did not execute");
        assert!(
            !s.sandbox.data.join("report.html").exists(),
            "continuation persisted data without approval"
        );
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn round_three_connector_steering_attended() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    steer(true, false).await
}
#[tokio::test]
async fn round_three_connector_steering_unattended() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    steer(true, true).await
}
#[tokio::test]
async fn round_three_clean_steering() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    steer(false, false).await
}
