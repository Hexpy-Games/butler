//! Library migration v2 on a real version-1 database: bookmark folders become
//! bookmark groups (positions in name order, names merged case-insensitively);
//! afterwards a `folder` in a saved bookmark names its group, and saving an
//! item again keeps its group, tags and user title.
use super::{ok, page};
use butler_e2e::e2e::{HarnessError, scenario::Setup};
use serde_json::{Value, json};

/// Rewinds the App database to the version-1 Library schema with these rows.
fn version_one(data: &std::path::Path) {
    let db = butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite")).unwrap();
    db.execute_batch(
        "BEGIN;
        DROP INDEX browser_library_time; DROP INDEX browser_library_group_time;
        DROP INDEX browser_library_site_time; DROP INDEX browser_library_name;
        DROP INDEX IF EXISTS browser_library_import_url;
        DROP INDEX IF EXISTS browser_bookmark_folder_url;
        CREATE UNIQUE INDEX IF NOT EXISTS browser_bookmark_url ON browser_library(url) WHERE kind='bookmark';
        ALTER TABLE browser_library DROP COLUMN group_id;
        ALTER TABLE browser_library DROP COLUMN site;
        ALTER TABLE browser_library DROP COLUMN title_key;
        DROP TABLE browser_library_group; DROP TABLE browser_library_tag; DROP TABLE browser_library_item_tag;
        DELETE FROM browser_library_migration WHERE version>=2;
        COMMIT;",
    )
    .unwrap();
    for (id, folder) in [
        ("w1", json!("Work")),
        ("w2", json!(" work ")),
        ("p1", json!("Personal")),
        ("e1", json!("")),
        ("n1", Value::Null),
    ] {
        use sha2::{Digest, Sha256};
        let url = format!("https://{id}.example.com/");
        let mut item = json!({"id": format!("bookmark-{:x}", Sha256::digest(url.as_bytes())), "kind": "bookmark", "title": format!("Page {id}"),
            "url": format!("https://{id}.example.com/"), "capturedAt": "2026-10-01T00:00:00.000Z"});
        if !folder.is_null() {
            item["folder"] = folder;
        }
        db.execute(
            "INSERT INTO browser_library(id,kind,title,url,payload,created_at) VALUES(?1,'bookmark',?2,?3,?4,?5)",
            rusqlite::params![item["id"].as_str(), item["title"].as_str(), item["url"].as_str(), item.to_string(), item["capturedAt"].as_str()],
        )
        .unwrap();
    }
}

fn bookmark(id: &str, folder: Option<&str>) -> Value {
    let mut item = json!({"id": "client-id", "kind": "bookmark", "title": format!("Page {id} again"),
        "url": format!("https://{id}.example.com/"), "capturedAt": "2026-10-02T00:00:00Z"});
    if let Some(folder) = folder {
        item["folder"] = json!(folder);
    }
    item
}

#[tokio::test]
async fn bookmark_folders_become_groups_once_and_resaves_keep_organization()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("BROWSER-LIBRARY-MIGRATION")?.start().await?;
    s.agent.terminate().await?;
    let data = s.sandbox.data.clone();
    tokio::task::spawn_blocking(move || version_one(&data))
        .await
        .unwrap();
    s.gw = s.agent.start_again().await?;
    let groups = page(&s, "/library/groups?kind=bookmark").await?;
    let listed = groups["groups"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            (
                g["name"].as_str().unwrap(),
                g["position"].as_i64().unwrap(),
                g["count"].as_i64().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(listed, [("Personal", 0, 1), ("Work", 1, 2)], "{groups}");
    assert_eq!(
        (groups["total"].as_i64(), groups["ungrouped"].as_i64()),
        (Some(5), Some(2))
    );
    let work = groups["groups"][1]["id"].as_str().unwrap().to_owned();
    let found = page(&s, "/library?kind=bookmark&q=work&sort=name").await?;
    assert_eq!(
        found["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| (
                i["title"].as_str().unwrap(),
                i["folder"].as_str().unwrap(),
                i["group"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        [
            ("Page w1", "Work", work.as_str()),
            ("Page w2", "Work", work.as_str())
        ]
    );
    assert_eq!(
        page(&s, "/library?kind=bookmark&site=n1.example.com").await?["items"][0]["site"],
        "n1.example.com"
    );
    // Runs once: a restart changes nothing.
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(page(&s, "/library/groups?kind=bookmark").await?, groups);

    // After the migration a folder names its group (created last when missing).
    let saved = ok(&s
        .gw
        .post("/library", bookmark("r1", Some("Reading")))
        .await?);
    let reading = page(&s, "/library/groups?kind=bookmark").await?["groups"][2].clone();
    assert_eq!(
        (reading["name"].as_str(), reading["position"].as_i64()),
        (Some("Reading"), Some(2))
    );
    assert_eq!(saved["group"], reading["id"]);
    let moved = ok(&s
        .gw
        .post("/library", bookmark("n1", Some("personal")))
        .await?);
    assert_eq!(moved["folder"], "Personal");

    // A re-save without folder (the address-bar star) keeps group, tags and the user's title.
    let id = saved["id"].as_str().unwrap();
    ok(&s
        .gw
        .patch(
            "/library/items",
            json!({"ids":[id],"addTags":["Later"],"title":"My reading"}),
        )
        .await?);
    let again = ok(&s.gw.post("/library", bookmark("r1", None)).await?);
    assert_eq!(
        (
            &again["group"],
            &again["tags"],
            &again["title"],
            &again["autoTitle"]
        ),
        (
            &reading["id"],
            &json!(["Later"]),
            &json!("My reading"),
            &json!("Page r1 again")
        )
    );
    let cleared = ok(&s.gw.post("/library", bookmark("r1", Some(""))).await?);
    assert_eq!(
        (&cleared["group"], cleared.get("folder")),
        (&Value::Null, None)
    );
    assert_eq!(cleared["tags"], json!(["Later"]));
    s.finish().await
}
