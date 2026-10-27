//! Asset scraps retain lossless originals through the Library's indexed refs.
use super::{ok, page};
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{
    HarnessError,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{io::Cursor, path::PathBuf};

fn png() -> Vec<u8> {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        64,
        48,
        image::Rgba([20, 80, 160, 100]),
    ));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}
fn scrap(asset: &str) -> Value {
    json!({"id":"picture", "kind":"scrap", "asset":asset, "url":"", "text":"",
        "title":"Lighthouse painting", "capturedAt":"2026-10-25T00:00:00Z"})
}
async fn generated(s: &Scenario, bytes: &[u8]) -> Result<(String, String), HarnessError> {
    let reply =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Pictures"}))
            .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let chat = reply.data();
    let session = chat["session"]["id"].as_str().unwrap().to_owned();
    let reply =
        s.gw.post(
            "/internal/e2e/images/generated",
            json!({
                "session":session, "data":STANDARD.encode(bytes),
                "model_ref":"openai/gpt-image-2.5-sunburst"
            }),
        )
        .await?;
    let asset = ok(&reply)["id"].as_str().unwrap().to_owned();
    Ok((session, asset))
}
async fn download(
    s: &Scenario,
    path: &str,
    signed: bool,
) -> Result<reqwest::Response, HarnessError> {
    let request = s.gw.http().get(format!("{}{path}", s.gw.base));
    let request = if signed {
        request
    } else {
        request.bearer_auth(&s.gw.token)
    };
    Ok(request.send().await?)
}
async fn stored(s: &Scenario, asset: &str, file: Option<PathBuf>) -> PathBuf {
    let data = s.sandbox.data.clone();
    let asset = asset.to_owned();
    tokio::task::spawn_blocking(move || {
        let db = butler_platform::sqlite::open(data.join("app-server/butler-client.sqlite")).unwrap();
        let count: i64 = db.query_row("SELECT COUNT(*) FROM app_assets WHERE id=?1", [&asset], |r| r.get(0)).unwrap();
        if let Some(file) = file {
            assert_eq!(count, 0);
            assert!(!file.exists(), "original was not swept");
            return file;
        }
        assert_eq!(count, 1);
        let hash: String = db.query_row("SELECT sha256 FROM app_assets WHERE id=?1", [&asset], |r| r.get(0)).unwrap();
        let refs: i64 = db.query_row("SELECT COUNT(*) FROM app_asset_refs WHERE asset_id=?1 AND owner_kind='library' AND owner_id='picture'", [&asset], |r| r.get(0)).unwrap();
        assert_eq!(refs, 1);
        let file = data.join("app-server/assets").join(&hash[..2]).join(format!("{hash}.png"));
        assert!(file.is_file());
        file
    }).await.unwrap()
}
#[tokio::test]
async fn asset_scrap_is_signed_searchable_and_keeps_original_after_chat_deletion()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("LIBRARY-PICTURE")?.start().await?;
    let bytes = png();
    let (session, asset) = generated(&s, &bytes).await?;
    let mut item = scrap(&asset);
    item["snapshot"] = json!({"width":64,"height":48,"html":"<!doctype html><p>Picture</p>"});
    let saved = ok(&s.gw.post("/library", item).await?);
    assert_eq!(saved["asset"], asset);
    assert_eq!(saved["img"], asset);
    assert!(saved.get("crop").is_none());
    assert_eq!(
        page(&s, "/library/picture/snapshot").await?["html"],
        "<!doctype html><p>Picture</p>"
    );
    // Re-saving and organizing exercise payload-update triggers as well as insertion.
    ok(&s.gw.post("/library", scrap(&asset)).await?);
    let organized = ok(&s.gw.post("/library/organize", json!({"ids":["picture"],"group":"Paintings","addTags":["coast"],"title":"Lighthouse original"})).await?);
    assert!(organized.to_string().contains(&asset));
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let listed = page(&s, "/library?kind=scrap&q=lighthouse&tags=coast").await?;
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    let picture = &listed["items"][0];
    assert_eq!(picture["asset"], asset);
    assert_eq!(picture["url"], "");
    let signed = picture["image_url"].as_str().unwrap();
    assert!(signed.contains('?'));
    let response = download(&s, signed, true).await?;
    assert_eq!(response.status(), 200);
    assert_eq!(response.bytes().await?.as_ref(), bytes);
    let search = page(&s, "/library/search?q=lighthouse").await?;
    assert_eq!(search["items"].as_array().unwrap().len(), 1);
    assert_eq!(search["items"][0]["asset"], asset);
    assert!(search["items"][0]["image_url"].is_string());
    ok(&s
        .gw
        .delete(&format!("/sessions/{session}?permanent=true"))
        .await?);
    let file = stored(&s, &asset, None).await;
    let response = download(&s, &format!("/message-assets/{asset}?download=1"), false).await?;
    assert_eq!(response.status(), 200);
    assert_eq!(response.bytes().await?.as_ref(), bytes);
    ok(&s.gw.delete("/library/picture").await?);
    stored(&s, &asset, Some(file)).await;
    assert_eq!(
        download(&s, &format!("/message-assets/{asset}?download=1"), false)
            .await?
            .status(),
        404
    );
    assert_eq!(
        page(&s, "/library?kind=scrap").await?["items"]
            .as_array()
            .unwrap()
            .as_slice(),
        &[] as &[Value]
    );
    s.finish().await
}
#[tokio::test]
async fn asset_scraps_reject_invalid_sources_without_replacing_saved_item()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("LIBRARY-PICTURE-VALIDATION")?.start().await?;
    let bytes = png();
    let (session, asset) = generated(&s, &bytes).await?;
    let response =
        s.gw.http()
            .post(format!(
                "{}/message-assets/masks?session={session}&for={asset}",
                s.gw.base
            ))
            .bearer_auth(&s.gw.token)
            .header("content-type", "image/png")
            .body(bytes)
            .send()
            .await?;
    assert_eq!(response.status(), 200);
    let mask: Value = response.json().await?;
    let base = scrap(&asset);
    ok(&s.gw.post("/library", base.clone()).await?);
    let mut both = base.clone();
    both["crop"] = json!("data:image/jpeg;base64,YQ==");
    let mut neither = base.clone();
    neither.as_object_mut().unwrap().remove("asset");
    let mut crop = neither.clone();
    crop["crop"] = json!("data:image/png;base64,YQ==");
    let mut bad_url = base.clone();
    bad_url["url"] = json!("file:///picture.png");
    let mut null_crop = base.clone();
    null_crop["crop"] = Value::Null;
    for bad in [
        both,
        neither,
        crop,
        null_crop,
        bad_url,
        scrap("img_0000000000"),
        scrap("img_invalid"),
        scrap(mask["data"]["id"].as_str().unwrap()),
        scrap(""),
    ] {
        let rejected = s.gw.post("/library", bad).await?;
        assert_eq!(rejected.status, 400, "{}", rejected.text);
        assert_eq!(rejected.error_code(), Some("invalid_library_item"));
        assert_eq!(rejected.body["error"]["message"], "Invalid saved item.");
    }
    let listed = page(&s, "/library?kind=scrap").await?;
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(listed["items"][0]["asset"], asset);
    s.finish().await
}
