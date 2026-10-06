//! P1a public publication, isolated content origin and immutable blobs.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
mod images;
mod security;
mod self_check;
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
    security::AdminClient,
};
use reqwest::Method;
use serde_json::{Value, json};

fn result(s: &Scenario, turn: &str) -> Value {
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let raw: String = db.query_row("SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='output_publish' AND turn_id=?1",[turn],|r|r.get(0)).unwrap();
    assert!(raw.len() <= 2048, "publish result {} bytes", raw.len());
    serde_json::from_str(&raw).unwrap()
}
fn blob_count(path: &std::path::Path) -> usize {
    std::fs::read_dir(path)
        .unwrap()
        .map(|s| std::fs::read_dir(s.unwrap().path()).unwrap().count())
        .sum()
}
#[tokio::test]
async fn published_outputs_are_isolated_deduplicated_and_revoked() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = Setup::new("BROWSER-OUTPUTS")?.stub_cassette(stub::cassette()?);
    let site = setup.sandbox.data.join("site");
    let mut s = setup.start().await?;
    let (turn, _) = s.turn("general", "Publish").await?;
    butler_platform::secure_fs::symlink(&site, &s.sandbox.data.join("linked"))?;
    let published = result(&s, &turn);
    assert_eq!(
        published["check"],
        json!({"status":"unavailable","reason":"no_browser"})
    );
    assert_eq!(published["new_blobs"], 2);
    let id = published["output_id"].as_str().unwrap();
    let view_path = format!("/outputs/{id}/view");
    let view = s.gw.get(&view_path).await?;
    assert_eq!(view.status, 200, "{}", view.text);
    let url = view.data()["url"].as_str().unwrap().to_owned();
    let client = reqwest::Client::new();
    let response = client.get(&url).send().await?;
    assert_eq!(response.status(), 200);
    for name in [
        "content-security-policy",
        "referrer-policy",
        "x-content-type-options",
        "cross-origin-opener-policy",
        "cache-control",
    ] {
        assert!(response.headers().contains_key(name), "{name}");
    }
    assert!(response.text().await?.contains("./app.js"));
    let content_origin = reqwest::Url::parse(&url)
        .unwrap()
        .origin()
        .ascii_serialization();
    assert_eq!(
        client
            .get(format!("{content_origin}/health"))
            .send()
            .await?
            .status(),
        404
    );
    let content_path = reqwest::Url::parse(&url).unwrap().path().to_owned();
    assert_eq!(s.gw.get(&content_path).await?.status, 404);
    assert_eq!(
        client
            .get(url.replace("/__o/", "/__o/forged"))
            .send()
            .await?
            .status(),
        403
    );
    assert_eq!(
        client
            .get(security::expired(&url, &s.gw.token))
            .send()
            .await?
            .status(),
        403
    );
    let traversal = url.replace("index.html", "%2e%2e%2findex.html");
    assert_eq!(client.get(traversal).send().await?.status(), 403);
    let (turn, _) = s.turn("general", "Again").await?;
    assert_eq!(result(&s, &turn)["new_blobs"], 0);
    assert_eq!(blob_count(&s.sandbox.data.join("outputs/blobs")), 2);
    s.restart().await?;
    assert_eq!(
        client.get(&url).send().await?.status(),
        200,
        "content survives restart"
    );
    for _ in 0..5 {
        let (turn, _) = s.turn("general", "Again").await?;
        assert_eq!(result(&s, &turn)["new_blobs"], 0);
    }
    let revisions = s.gw.get(&view_path).await?;
    assert_eq!(revisions.data()["revisions"], json!([3, 4, 5, 6, 7]));
    let fresh_url = revisions.data()["url"].as_str().unwrap().to_owned();
    assert_eq!(
        client.get(&url).send().await?.status(),
        403,
        "discarded revision"
    );
    let many = s.sandbox.data.join("many");
    std::fs::create_dir_all(&many)?;
    std::fs::write(many.join("index.html"), "Many")?;
    for n in 0..2000 {
        std::fs::write(many.join(format!("{n}.txt")), "x")?;
    }
    let (turn, _) = s.turn("general", "Many").await?;
    assert_eq!(result(&s, &turn)["error"], "output_limit_exceeded");
    let large = s.sandbox.data.join("large");
    std::fs::create_dir_all(&large)?;
    std::fs::File::create(large.join("index.html"))?.set_len(100_000_001)?;
    let (turn, _) = s.turn("general", "Large").await?;
    assert_eq!(result(&s, &turn)["error"], "output_limit_exceeded");
    let (turn, _) = s.turn("general", "Traversal").await?;
    assert!(
        result(&s, &turn)["error"]
            .as_str()
            .unwrap()
            .contains("unsafe_output_path")
    );
    let (turn, _) = s.turn("general", "Symlink").await?;
    assert!(
        result(&s, &turn)["error"]
            .as_str()
            .unwrap()
            .contains("symlink")
    );
    std::fs::write(
        s.sandbox.data.join("site/space +%.html"),
        "Encoded filename",
    )?;
    let (turn, _) = s.turn("general", "Spaced").await?;
    let spaced = result(&s, &turn);
    let link = s.gw.get(spaced["view"].as_str().unwrap()).await?;
    let content = client
        .get(link.data()["url"].as_str().unwrap())
        .send()
        .await?;
    assert_eq!(content.status(), 200);
    assert_eq!(content.text().await?, "Encoded filename");
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let patch = admin
        .send(
            Method::PATCH,
            "/settings",
            Some(json!({"security":{"allowed_hosts":["butler.example.info"]}})),
            &[],
        )
        .await?;
    assert_eq!(patch.status, 200, "{}", patch.text);
    let overlap = admin
        .send(
            Method::PATCH,
            "/settings",
            Some(json!({"security":{"content_hosts":["BUTLER.example.info"]}})),
            &[],
        )
        .await?;
    assert_eq!(overlap.status, 400, "content origin must be separate");
    let missing =
        s.gw.send_with(
            Method::GET,
            &view_path,
            None,
            Some(&s.gw.token),
            &[("host", "butler.example.info")],
        )
        .await?;
    assert_eq!(missing.error_code(), Some("content_host_required"));
    let patch = admin
        .send(
            Method::PATCH,
            "/settings",
            Some(json!({"security":{"content_hosts":["outputs.example.info"]}})),
            &[],
        )
        .await?;
    assert_eq!(patch.status, 200, "{}", patch.text);
    let tunnel =
        s.gw.send_with(
            Method::GET,
            &view_path,
            None,
            Some(&s.gw.token),
            &[("host", "butler.example.info")],
        )
        .await?;
    assert!(
        tunnel.data()["url"]
            .as_str()
            .unwrap()
            .starts_with("https://outputs.example.info/__o/")
    );
    let rotated = admin
        .send(Method::POST, "/security/connection-code/rotate", None, &[])
        .await?;
    assert_eq!(rotated.status, 200, "{}", rotated.text);
    assert_eq!(client.get(&fresh_url).send().await?.status(), 403);
    s.finish().await
}

fn output_files(root: &std::path::Path) -> Vec<(String, u64, std::time::SystemTime)> {
    fn visit(
        root: &std::path::Path,
        path: &std::path::Path,
        items: &mut Vec<(String, u64, std::time::SystemTime)>,
    ) {
        for entry in std::fs::read_dir(path).unwrap() {
            let entry = entry.unwrap();
            let metadata = entry.metadata().unwrap();
            if metadata.is_dir() {
                visit(root, &entry.path(), items);
            } else {
                items.push((
                    entry
                        .path()
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    metadata.len(),
                    metadata.modified().unwrap(),
                ));
            }
        }
    }
    let mut files = Vec::new();
    visit(root, root, &mut files);
    files.sort();
    files
}
#[tokio::test]
async fn published_outputs_idle_ten_minutes_without_writes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("OUTPUT-IDLE")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    let (turn, _) = s.turn("general", "Publish").await?;
    let output = result(&s, &turn);
    assert_eq!(output["new_blobs"], 2);
    let host = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", s.agent.launch.admin_credential().unwrap())
        .send()
        .await?;
    assert_eq!(host.status(), 200);
    let root = s.sandbox.data.join("outputs");
    let before = output_files(&root);
    assert_eq!(blob_count(&root.join("blobs")), 2);
    tokio::time::sleep(std::time::Duration::from_secs(600)).await;
    assert_eq!(output_files(&root), before, "idle output-owned writes");
    assert_eq!(blob_count(&root.join("blobs")), 2);
    let view = s.gw.get(output["view"].as_str().unwrap()).await?;
    assert_eq!(view.status, 200);
    let body = reqwest::get(view.data()["url"].as_str().unwrap())
        .await?
        .text()
        .await?;
    assert!(body.contains("./app.js"));
    drop(host);
    eprintln!("output + attached hub idle: 600 seconds, 0 writes, 2 complete blobs");
    s.finish().await
}

#[tokio::test]
async fn archive_collects_only_unreferenced_output_blobs() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("OUTPUT-GC")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    let first =
        s.gw.post("/sessions", json!({"kind":"chat","title":"First output"}))
            .await?;
    assert_eq!(first.status, 201, "{}", first.text);
    let first_id = first.data()["session"]["id"].as_str().unwrap().to_owned();
    let second =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Second output"}))
            .await?;
    assert_eq!(second.status, 201, "{}", second.text);
    let second_id = second.data()["session"]["id"].as_str().unwrap().to_owned();
    let (turn, _) = s.turn(&first_id, "Publish").await?;
    let first_output = result(&s, &turn);
    assert_eq!(first_output["new_blobs"], 2);
    let (turn, _) = s.turn(&second_id, "Publish").await?;
    let second_output = result(&s, &turn);
    assert_eq!(second_output["new_blobs"], 0);
    let archived =
        s.gw.post(&format!("/sessions/{first_id}/archive"), json!({}))
            .await?;
    assert_eq!(archived.status, 200, "{}", archived.text);
    assert_eq!(blob_count(&s.sandbox.data.join("outputs/blobs")), 2);
    let survivor = s.gw.get(second_output["view"].as_str().unwrap()).await?;
    assert_eq!(survivor.status, 200);
    assert_eq!(
        reqwest::get(survivor.data()["url"].as_str().unwrap())
            .await?
            .status(),
        200
    );
    let archived =
        s.gw.post(&format!("/sessions/{second_id}/archive"), json!({}))
            .await?;
    assert_eq!(archived.status, 200, "{}", archived.text);
    assert_eq!(blob_count(&s.sandbox.data.join("outputs/blobs")), 0);
    s.finish().await
}
