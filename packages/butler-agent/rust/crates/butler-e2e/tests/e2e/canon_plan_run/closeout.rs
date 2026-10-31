use super::*;
use std::sync::atomic::Ordering;

/// A model may close direct Work with its plan review alone; BTCC accepts that
/// closeout, so the queue must not wait for reviews that never come.
#[tokio::test]
async fn plan_run_advances_when_work_closes_without_later_reviews() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server, first, chat) =
        crate::canon_link::setup("CB-CLOSEOUT", false, false).await?;
    let (plan, epics) = plan(&s, &script, &first).await?;
    script.plan_review_only.store(true, Ordering::SeqCst);
    script.release();
    data(
        s.gw.post(
            &format!("/sessions/{chat}/canon/queue"),
            json!({"op":"plan_run","plan_id":plan}),
        )
        .await?,
        200,
    );
    let view = wait_done(&s, &chat, 3).await?;
    assert_eq!(view["counts"]["held"], 0, "{view}");
    for epic in &epics {
        let row = data(s.gw.get(&format!("/canon/epics/{epic}")).await?, 200);
        assert_eq!(row["canon_status"], "in_review", "{row}");
        assert_eq!(row["running"], json!(false), "{row}");
    }
    for item in view["chains"][0]["steps"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|step| step["items"].as_array().unwrap())
    {
        // BTCC never recorded a reporting checkpoint, yet the Work is finished.
        assert_eq!(item["progress"]["stage"], "reporting", "{item}");
        assert_eq!(item["progress"]["disposition"], "completed", "{item}");
    }
    s.finish().await?;
    server.abort();
    Ok(())
}
