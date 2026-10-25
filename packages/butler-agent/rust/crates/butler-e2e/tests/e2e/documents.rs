//! Stub model and authenticated App flows for editable Markdown deliverables.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod measurements;
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    events::LiveEvents,
    gateway::turn_state,
    scenario::{Scenario, Setup},
};
use rusqlite::params;
use serde_json::{Value, json};
const CREATE: &str = "Create the editable report.";
const READ: &str = "Read my saved report.";
const EDIT: &str = "Review my changes and update the untouched paragraph.";
const IMAGE: &str = "img_abcdefghij";
fn body() -> String {
    format!(
        "# Report\nOriginal line\nUntouched paragraph\n\n```blocks\n{}\n```\n![Image alt]({IMAGE})\n",
        json!({"v":1,"blocks":[{"type":"cards","id":"summary","items":[{"title":"청자","text":"orchard"}]}]})
    )
}
fn ok(reply: butler_e2e::e2e::gateway::Reply) -> Value {
    assert_eq!(reply.status, 200, "{}", reply.text);
    let mut body = reply.body;
    body["data"].take()
}
fn db(s: &Scenario) -> Result<rusqlite::Connection, HarnessError> {
    Ok(rusqlite::Connection::open(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
    )?)
}
async fn put(
    s: &Scenario,
    id: &str,
    expected: i64,
    body: &str,
    author: &str,
) -> Result<Value, HarnessError> {
    let reply =
        s.gw.http()
            .put(format!("{}/documents/{id}", s.gw.base))
            .bearer_auth(&s.gw.token)
            .json(&json!({"expected_rev":expected,"body":body,"author":author}))
            .send()
            .await?;
    let status = reply.status();
    let value: Value = reply.json().await?;
    assert_eq!(status, 200, "{value}");
    Ok(value["data"].clone())
}
fn seed_image(s: &Scenario) -> Result<(), HarnessError> {
    let image =
        butler_runtime::browser::normalize_image(include_bytes!("browser_outputs/pixel.jpg"))
            .unwrap();
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(&image.bytes));
    let path = s.sandbox.data.join("app-server/assets").join(&hash[..2]);
    std::fs::create_dir_all(&path)?;
    std::fs::write(path.join(format!("{hash}.jpg")), &image.bytes)?;
    let db = db(s)?;
    db.execute("INSERT INTO app_assets(id,sha256,mime,width,height,bytes,alt,source_url,created_at,pixel_ratio) VALUES(?1,?2,'image/jpeg',1200,800,?3,'Image alt','https://example.org/image','2026-10-25T00:00:00Z',2)",params![IMAGE,hash,image.bytes.len()])?;
    db.execute(
        "INSERT INTO app_asset_refs VALUES(?1,'chat','general')",
        [IMAGE],
    )?;
    Ok(())
}
#[tokio::test]
async fn editable_document_create_correct_search_coalesce_diff_edit_restore_delete()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("EDITABLE-DOCUMENTS")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    seed_image(&s)?;
    let live = LiveEvents::subscribe(&s.gw, 0).await?;
    let (_, turn) = s.turn("general", CREATE).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());
    let listed = ok(s.gw.get("/library?kind=doc").await?);
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{listed}");
    let id = items[0]["id"].as_str().unwrap();
    let head = ok(s.gw.get(&format!("/documents/{id}")).await?);
    assert_eq!(head["body"], body());
    assert_document_image(&head);
    let original = ok(s.gw.get(&format!("/documents/{id}/revisions/1")).await?);
    assert_document_image(&original);
    assert_eq!(head["rev"], 1);
    assert_eq!(head["author"], "butler");
    let messages = s.gw.messages("general").await?;
    assert!(messages.iter().any(|message| {
        message["role"] == "assistant"
            && message["id"] == head["message_id"]
            && message["artifacts"].as_array().is_some_and(|items| {
                items.iter().any(|item| {
                    item["kind"] == "doc" && item["id"] == id && item["deliverable"] == true
                })
            })
    }));
    mixed_document_section(&s, id)?;
    let mixed = ok(s.gw.get("/library?kinds=doc,document").await?);
    let kinds = mixed["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["kind"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(kinds, vec!["document", "doc"]);
    assert_eq!(mixed["items"][1]["id"], id);
    for word in ["청자", "orchard"] {
        let url = reqwest::Url::parse_with_params(
            "http://localhost/library",
            [("kind", "doc"), ("q", word)],
        )
        .unwrap();
        let found = ok(s
            .gw
            .get(&format!("/library?{}", url.query().unwrap()))
            .await?);
        assert_eq!(found["items"][0]["id"], id, "{found}");
    }
    let first = body().replace("Original line", "User first line");
    assert_eq!(put(&s, id, 1, &first, "user").await?["rev"], 2);
    let second = first.replace("User first line", "User final line");
    assert_eq!(put(&s, id, 2, &second, "user").await?["rev"], 2);
    let revisions = ok(s.gw.get(&format!("/documents/{id}/revisions")).await?);
    assert_eq!(revisions.as_array().unwrap().len(), 2);
    assert_eq!(revisions[0]["author"], "user");
    assert!(revisions[0].get("body").is_none());
    let diff = ok(s.gw.get(&format!("/documents/{id}/diff?from=1")).await?);
    assert!(diff["diff"].as_str().unwrap().contains("+User final line"));
    let event_count = || {
        db(&s)
            .unwrap()
            .query_row(
                "SELECT count(*) FROM events WHERE type='document.updated'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap()
    };
    let before_seen = event_count();
    ok(s.gw
        .post(
            &format!("/documents/{id}/seen"),
            json!({"chat_id":"general","rev":2}),
        )
        .await?);
    assert_eq!(
        event_count(),
        before_seen,
        "seen does not publish a document change"
    );
    let (_, read) = s.turn("general", READ).await?;
    assert_eq!(turn_state(&read), "delivered", "{read}");
    assert_eq!(
        event_count(),
        before_seen,
        "reading does not publish a document change"
    );
    let second = second.replace("User final line", "User latest line");
    assert_eq!(
        put(&s, id, 2, &second, "user").await?["rev"],
        3,
        "a save after Butler sees a user revision must append"
    );
    let (turn_id, turn) = s.turn("general", EDIT).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}\n{}", s.agent.logs());
    let head = ok(s.gw.get(&format!("/documents/{id}")).await?);
    assert_eq!(head["rev"], 4);
    assert_eq!(
        head["body"],
        second.replace("Untouched paragraph", "Butler updated paragraph")
    );
    let requests = s.provider()?.requests();
    assert!(
        requests
            .iter()
            .any(|r| r.to_string().contains("The user edited the document"))
    );
    assert!(
        requests
            .iter()
            .any(|r| r.to_string().contains("+User latest line"))
    );
    assert!(
        requests
            .iter()
            .any(|r| r.to_string().contains("region_changed"))
    );
    for code in ["invalid_anchor", "overlapping_ops"] {
        assert!(
            requests
                .iter()
                .any(|request| request.to_string().contains(code))
        );
    }
    assert!(
        requests
            .iter()
            .any(|r| r.to_string().contains("invalid_embeds"))
    );
    let messages = s.gw.messages("general").await?;
    let user = messages
        .iter()
        .find(|m| m["role"] == "user" && m["turn_id"] == turn_id)
        .unwrap();
    assert_eq!(user["text"], EDIT);
    assert!(messages.iter().any(|message| {
        message["role"] == "assistant"
            && message["turn_id"] == turn_id
            && message["artifacts"].as_array().is_some_and(|items| {
                items.iter().any(|item| {
                    item["kind"] == "doc" && item["id"] == id && item["deliverable"] == true
                })
            })
    }));
    assert!(!json!(messages).to_string().contains("invalid_embeds"));
    let restored = ok(s
        .gw
        .post(
            &format!("/documents/{id}/restore"),
            json!({"rev":1,"expected_rev":4}),
        )
        .await?);
    assert_eq!(restored["rev"], 5);
    assert_eq!(restored["body"], body());
    let history = ok(s.gw.get(&format!("/documents/{id}/revisions")).await?);
    assert_eq!(
        history
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["author"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["user", "butler", "user", "user", "butler"]
    );
    let stale =
        s.gw.http()
            .put(format!("{}/documents/{id}", s.gw.base))
            .bearer_auth(&s.gw.token)
            .json(&json!({"expected_rev":2,"body":"stale","author":"user"}))
            .send()
            .await?;
    assert_eq!(stale.status(), 409);
    assert_eq!(stale.json::<Value>().await?["rev"], 5);
    live.wait_for(std::time::Duration::from_secs(10), |e| {
        e["type"] == "document.updated"
            && e["payload"]["id"] == id
            && e["payload"]["rev"] == 4
            && e["payload"]["changed"]
                .as_array()
                .is_some_and(|ranges| !ranges.is_empty())
    })
    .await?;
    let db = db(&s)?;
    db.execute("UPDATE document_revisions SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-121 seconds') WHERE document_id=?1 AND rev=5",[id])?;
    assert_eq!(
        put(&s, id, 5, &body(), "user").await?["rev"],
        6,
        "saves outside the idle window append"
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM document_bodies", [], |row| row
            .get::<_, i64>(0))?,
        4,
        "restore deduplicates, replaced user body is removed"
    );
    db.execute(
        "DELETE FROM app_asset_refs WHERE owner_kind='chat' AND owner_id='general' AND asset_id=?1",
        [IMAGE],
    )?;
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM app_assets WHERE id=?1",
            [IMAGE],
            |r| r.get::<_, i64>(0)
        )?,
        1
    );
    ok(s.gw.delete(&format!("/library/{id}")).await?);
    assert_eq!(s.gw.get(&format!("/documents/{id}")).await?.status, 404);
    for table in [
        "documents",
        "document_revisions",
        "document_seen",
        "document_bodies",
    ] {
        assert_eq!(
            db.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                .get::<_, i64>(0))?,
            0,
            "{table}"
        );
    }
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM app_assets WHERE id=?1",
            [IMAGE],
            |r| r.get::<_, i64>(0)
        )?,
        0
    );
    drop(db);
    drop(live);
    eprintln!(
        "documents: 6 revisions (2 user saves coalesced); 2 language searches; asset refs released"
    );
    s.finish().await
}

fn mixed_document_section(s: &Scenario, _id: &str) -> Result<(), HarnessError> {
    let payload = json!({"id":"file-deliverable","kind":"document","title":"Deliverable","url":"/message-files/file","capturedAt":"2099-01-01T00:00:00Z"});
    db(s)?.execute("INSERT INTO browser_library(id,kind,title,url,payload,created_at) VALUES('file-deliverable','document','Deliverable','/message-files/file',?1,'2099-01-01T00:00:00Z')", [payload.to_string()])?;
    Ok(())
}

fn assert_document_image(document: &Value) {
    let asset = &document["assets"][0];
    assert_eq!(asset["id"], IMAGE);
    assert_eq!(asset["image_width"], 600.0);
    assert_eq!(asset["image_height"], 400.0);
    assert!(
        asset["signed_url"]
            .as_str()
            .unwrap()
            .contains("/message-assets/")
    );
}
