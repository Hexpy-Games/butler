//! Real local-page source collection, storage, signed delivery and change-driven deletion.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::support::{self, admin, call, node, open, setup};
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use std::{fs, time::Duration};

#[tokio::test]
async fn image_assets_collect_dedupe_crop_guard_serve_and_sweep() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    butler_e2e::skip_unless!(support::selected(), "Real browser backend not selected");
    let setup = setup("IMAGE-ASSETS")?;
    let s = setup.start().await?;
    let admin = admin(&s);
    let chat =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Image assets"}))
            .await?;
    assert_eq!(chat.status, 201, "{}", chat.text);
    let session = chat.data()["session"]["id"].as_str().unwrap();
    let (_, url) = support::publish_in(&s, session, "Publish images").await?;
    let tab = open(&admin, session, &url).await?["tab"].clone();
    let page = call(
        &admin,
        session,
        "tab.observe",
        &tab,
        json!({"include_image":true}),
    )
    .await?;
    let reference = node(&page, "image", "Source raster")["ref"].clone();
    let collect = json!({"ref":reference,"observation":page["obs"]});
    let first = call(&admin, session, "tab.image_collect", &tab, collect.clone()).await?;
    assert_eq!(first["status"], "ok", "{first}");
    assert_eq!(first["alt"], "Source raster");
    assert!(
        first["nearby_text"]
            .as_str()
            .unwrap()
            .contains("Nearby description")
    );
    let lookup = call(
        &admin,
        session,
        "assets.lookup",
        &Value::Null,
        json!({"ids":[first["id"],"img_0000000000"]}),
    )
    .await?;
    assert_eq!(lookup["ids"], json!([first["id"]]));
    let root = s.sandbox.data.join("app-server/assets");
    let files_before = files(&root)?;
    let expected =
        butler_runtime::browser::normalize_image(include_bytes!("../browser_outputs/pixel.jpg"))
            .unwrap();
    assert_eq!(
        fs::read(&files_before[0].0)?,
        expected.bytes,
        "Ref must retain the source pixels rather than its displayed thumbnail"
    );
    let repeat = call(&admin, session, "tab.image_collect", &tab, collect).await?;
    assert_eq!(first["id"], repeat["id"]);
    assert_eq!(files_before, files(&root)?);
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("app-server/butler-client.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    assert_eq!(
        db.query_row("SELECT count(*) FROM app_assets", [], |r| r
            .get::<_, u32>(0))?,
        1
    );
    assert_eq!(files_before.len(), 1);
    let (width, height, size): (u32, u32, u32) =
        db.query_row("SELECT width,height,bytes FROM app_assets", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
    assert!(width.max(height) <= 1280 && size <= 250 * 1024);
    let rect = &node(&page, "image", "Source raster")["rect"];
    let crop = call(
        &admin,
        session,
        "tab.image_collect",
        &tab,
        json!({"region":[rect["x"],rect["y"],120,100],"observation":page["obs"]}),
    )
    .await?;
    assert_eq!(crop["status"], "ok", "{crop}");
    assert!(crop["width"].as_u64().unwrap() <= 240);
    let bad_ref = node(&page, "image", "Not a raster")["ref"].clone();
    let bad = call(
        &admin,
        session,
        "tab.image_collect",
        &tab,
        json!({"ref":bad_ref,"observation":page["obs"]}),
    )
    .await?;
    assert_ne!(bad["status"], "ok", "{bad}");
    let private = call(
        &admin,
        session,
        "tab.image_collect",
        &tab,
        json!({"url":"http://127.0.0.1:9/private.jpg","observation":page["obs"]}),
    )
    .await?;
    assert_eq!(private["reason"], "private_image_url", "{private}");
    verify_delivery(&s, &first).await?;
    save_evidence(&s, &page, &crop, &files_before[0].0).await?;
    call(&admin, session, "tab.close", &tab, json!({})).await?;
    let mut watch = crate::idle_resources::writes::Watch::open_after_quiet(&s.sandbox.data).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    watch.assert_unchanged();
    eprintln!(
        "asset rows=1 files=1 before crop; normalized {width}x{height} {size} bytes; idle writes=0"
    );
    drop(db);
    assert_eq!(
        s.gw.delete(&format!("/sessions/{session}?permanent=true"))
            .await?
            .status,
        200
    );
    assert_eq!(
        files(&root)?.len(),
        1,
        "Library keeps the source asset after chat deletion"
    );
    assert_eq!(s.gw.get(first["url"].as_str().unwrap()).await?.status, 200);
    assert_eq!(s.gw.delete("/library/saved-image").await?.status, 200);
    assert_eq!(
        files(&root)?.len(),
        0,
        "Last library reference sweeps the source asset"
    );
    assert_eq!(s.gw.get(first["url"].as_str().unwrap()).await?.status, 404);
    s.finish().await
}
fn files(
    root: &std::path::Path,
) -> Result<Vec<(std::path::PathBuf, u64, std::time::SystemTime)>, std::io::Error> {
    let mut result = Vec::new();
    for dir in fs::read_dir(root)? {
        for file in fs::read_dir(dir?.path())? {
            let file = file?;
            let meta = file.metadata()?;
            result.push((file.path(), meta.len(), meta.modified()?));
        }
    }
    result.sort();
    Ok(result)
}
async fn verify_delivery(
    s: &butler_e2e::e2e::scenario::Scenario,
    asset: &Value,
) -> Result<(), HarnessError> {
    let url = asset["url"].as_str().unwrap();
    let unsigned = reqwest::get(format!("{}{url}", s.gw.base)).await?;
    assert_eq!(unsigned.status(), 401);
    let signed = asset["signed_url"].as_str().unwrap();
    let image = reqwest::get(format!("{}{signed}&w=80", s.gw.base)).await?;
    assert_eq!(image.status(), 200);
    assert_eq!(image.headers()["cache-control"], "no-store");
    assert_eq!(image.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        image.headers()["content-security-policy"],
        "sandbox; default-src 'none'"
    );
    let bytes = image.bytes().await?;
    let decoder = butler_runtime::browser::normalize_image(&bytes).unwrap();
    assert_eq!(decoder.width, 80);
    let saved=s.gw.post("/library",json!({"id":"saved-image","kind":"scrap","title":"Saved image","url":"https://example.com/","text":"Source raster","crop":format!("data:image/jpeg;base64,{}",STANDARD.encode(&bytes)),"img":asset["id"],"capturedAt":"2026-10-12T00:00:00Z"})).await?;
    assert_eq!(saved.status, 200, "{}", saved.text);
    if let Some(dir) = std::env::var_os("BUTLER_E2E_BROWSER_EVIDENCE") {
        fs::write(
            std::path::Path::new(&dir).join("collected-resize.jpg"),
            bytes,
        )?;
    }
    Ok(())
}

pub(super) fn page() -> String {
    format!(
        r#"<!doctype html><meta charset="utf-8"><title>Images</title>
      <style>body{{margin:0}}img{{width:200px;height:160px}}</style><main>Nearby description
      <img src="data:image/jpeg;base64,{}" alt="Source raster"><img src="not-image.txt" alt="Not a raster">
      <img src="http://127.0.0.1:9/private.jpg" alt="Private image"></main>"#,
        STANDARD.encode(include_bytes!("../browser_outputs/pixel.jpg"))
    )
}

async fn save_evidence(
    s: &butler_e2e::e2e::scenario::Scenario,
    page: &Value,
    crop: &Value,
    original: &std::path::Path,
) -> Result<(), HarnessError> {
    let Some(dir) = std::env::var_os("BUTLER_E2E_BROWSER_EVIDENCE") else {
        return Ok(());
    };
    let dir = std::path::Path::new(&dir);
    fs::copy(original, dir.join("collected-source.jpg"))?;
    fs::write(
        dir.join("fixture-observation.jpg"),
        STANDARD
            .decode(page["image"]["data"].as_str().unwrap())
            .unwrap(),
    )?;
    let response = reqwest::get(format!(
        "{}{}",
        s.gw.base,
        crop["signed_url"].as_str().unwrap()
    ))
    .await?;
    assert_eq!(response.status(), 200);
    fs::write(dir.join("region-crop.jpg"), response.bytes().await?)?;
    eprintln!("region crop {}x{}", crop["width"], crop["height"]);
    Ok(())
}
