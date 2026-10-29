use super::*;
#[tokio::test]
async fn evidence_bundle_decline_and_ignored_candidate_are_durable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("PATTERNS-BUNDLE").await?;
    seed(&s, 0, 8)?;
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("runtime/conversation-store.sqlite"))?;
    db.execute("INSERT INTO conversation_messages(id,session_id,seq,role,status,visibility,provenance,created_at,origin_kind) VALUES('pattern-internal-control','pattern-source',100,'user','complete','user','imported','2026-10-24T07:48:00.000Z','internal_control')", [])?;
    enable(&s).await?;
    let store = run(&s).await?;
    assert!(
        !requests(&s, "pattern_extraction")[0]["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["id"] == "pattern-internal-control")
    );
    assert_eq!(store["schema"], "butler.cognition.patterns.v1");
    assert_eq!(store["patterns"].as_array().unwrap().len(), 2);
    assert_eq!(store["bundles"].as_array().unwrap().len(), 1);
    for p in store["patterns"].as_array().unwrap() {
        assert_eq!(p["evidence"]["count"], 4);
        assert_eq!(p["evidence"]["first_at"], "2026-10-02T07:48:00Z");
        assert_eq!(p["evidence"]["last_at"], "2026-10-23T07:48:00Z");
        assert!(p["proposed_at"].is_string());
    }
    let pending = s.gw.get("/memory/pattern-proposals").await?.data().clone();
    let mut public_bundles = store["bundles"].clone();
    for candidate in public_bundles
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .flat_map(|b| b["candidates"].as_array_mut().unwrap())
    {
        candidate["action"]
            .as_object_mut()
            .unwrap()
            .remove("prompt");
    }
    assert_eq!(pending["bundles"], public_bundles);
    let bundle = &store["bundles"][0];
    let declined = &bundle["candidates"][0]["pattern_id"];
    let ignored = &bundle["candidates"][1]["pattern_id"];
    let path = format!(
        "/memory/pattern-proposals/{}",
        bundle["id"].as_str().unwrap()
    );
    let r = s.gw.post(&path, json!({"pattern_id":declined,"decision":"declined","expected_revision":store["revision"]})).await?;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(s.gw.post(&path, json!({"pattern_id":ignored,"decision":"accepted","expected_revision":store["revision"]})).await?.status, 409);
    s.restart().await?;
    seed(&s, 8, 4)?;
    let after = run(&s).await?;
    assert_eq!(after["removed"][0]["id"], *declined);
    assert_eq!(after["removed"][0]["reason"], "declined");
    assert_eq!(after["bundles"].as_array().unwrap().len(), 1);
    assert_eq!(after["bundles"][0]["candidates"][0]["state"], "declined");
    assert!(
        !after["patterns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == *declined)
    );
    let extraction = requests(&s, "pattern_extraction");
    let last = extraction.last().unwrap();
    assert_eq!(last["removed"][0]["id"], *declined);
    assert_eq!(
        last["events"].as_array().unwrap().len(),
        4,
        "incremental only"
    );
    let proposals = requests(&s, "pattern_proposal");
    let last = proposals.last().unwrap();
    assert_eq!(last["removed"][0]["id"], *declined);
    assert!(
        !last["patterns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == *ignored)
    );
    assert_eq!(last["already_proposed"].as_array().unwrap().len(), 1);
    let r = s.gw.post(&path, json!({"pattern_id":ignored,"decision":"accepted","expected_revision":after["revision"]})).await?;
    assert_eq!(r.status, 200, "{}", r.text);
    let accepted = read_store(&s);
    assert_eq!(accepted["bundles"][0]["candidates"][1]["state"], "accepted");
    assert!(
        accepted["patterns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == *ignored)
    );
    assert_eq!(
        s.gw.get("/memory/pattern-proposals").await?.data()["bundles"],
        json!([])
    );
    s.finish().await
}
#[tokio::test]
async fn delete_records_a_tombstone_and_stale_revision_conflicts() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = setup("PATTERNS-DELETE").await?;
    seed(&s, 0, 8)?;
    enable(&s).await?;
    let store = run(&s).await?;
    let id = &store["patterns"][0]["id"];
    let path = format!("/memory/patterns/{}", id.as_str().unwrap());
    let body = json!({"expected_revision":store["revision"]}).to_string();
    let r =
        s.gw.send(reqwest::Method::DELETE, &path, Some(body.clone()))
            .await?;
    assert_eq!(r.status, 200, "{}", r.text);
    assert_eq!(
        s.gw.send(reqwest::Method::DELETE, &path, Some(body))
            .await?
            .status,
        409
    );
    let view = s.gw.get("/memory/patterns").await?.data().clone();
    assert!(
        !view["patterns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == *id)
    );
    let events = s.gw.events_since(0).await?;
    assert!(events.iter().any(|e| e["type"] == "memory.operation"
        && e["payload"]["kind"] == "patterns"
        && e["payload"]["phase"] == "complete"));
    s.agent.terminate().await?;
    seed(&s, 8, 4)?;
    s.gw = s.agent.start_again().await?;
    let after = run(&s).await?;
    assert_eq!(after["removed"][0]["id"], *id);
    assert_eq!(after["removed"][0]["reason"], "deleted");
    assert!(
        !after["patterns"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == *id)
    );
    assert_eq!(after["bundles"].as_array().unwrap().len(), 1);
    assert_eq!(
        requests(&s, "pattern_extraction").last().unwrap()["removed"][0]["id"],
        *id
    );
    let revision = after["revision"].clone();
    assert_eq!(
        s.gw.send(
            reqwest::Method::DELETE,
            "/memory/patterns/unknown",
            Some(json!({"expected_revision":revision}).to_string())
        )
        .await?
        .status,
        404
    );
    s.finish().await
}
