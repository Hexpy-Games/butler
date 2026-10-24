use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{
    HarnessError,
    fake_chatgpt::FakeChatGptAuthority,
    fixtures,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::io::Cursor;

const MODEL: &str = "openai/gpt-image-2.5-sunburst";
async fn put(s: &Scenario, value: Value) -> Result<butler_e2e::e2e::gateway::Reply, HarnessError> {
    s.gw.send(
        reqwest::Method::PUT,
        "/settings/image-model",
        Some(value.to_string()),
    )
    .await
}
#[tokio::test]
async fn image_model_settings_are_durable_and_separate_from_chat() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let authority = FakeChatGptAuthority::start().await?;
    let setup = Setup::new("IMAGE-MODEL-SETTINGS")?
        .without_credential()
        .env("BUTLER_CHATGPT_AUTH_ISSUER", &authority.issuer)
        .env(
            "BUTLER_CHATGPT_API_BASE_URL",
            format!("{}/v1", authority.issuer),
        );
    fixtures::stub_chatgpt_auth(&setup.sandbox.data, &authority)?;
    let mut s = setup.start().await?;
    let saved =
        s.gw.post(
            "/credentials",
            json!({"provider_id":"openai","api_key":"image-fixture-key"}),
        )
        .await?;
    assert_eq!(saved.status, 201, "{}", saved.text);
    let credential = saved.data()["credential"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let listed = s.gw.get("/settings/image-model").await?;
    assert_eq!(listed.status, 200, "{}", listed.text);
    let models = listed.data()["models"].as_array().unwrap();
    assert_eq!(models.len(), 6);
    let model = models.iter().find(|m| m["model_ref"] == MODEL).unwrap();
    assert_eq!(model["edit"], true);
    assert_eq!(model["mask"], "alpha");
    assert_eq!(model["transparent_background"], true);
    let keys = model["credentials"].as_array().unwrap();
    assert!(
        keys.iter()
            .any(|c| c["id"] == credential && c["selectable"] == true)
    );
    let signin = keys
        .iter()
        .find(|c| c["auth_type"] == "chatgpt_oauth")
        .unwrap();
    assert_eq!(signin["selectable"], false);
    assert_eq!(signin["reason"], "chatgpt_sign_in");
    let rejected = put(&s, json!({"model_ref":MODEL,"credential_id":signin["id"]})).await?;
    assert_eq!(rejected.status, 400);
    assert_eq!(rejected.error_code(), Some("image_model_requires_api_key"));
    let rejected = put(
        &s,
        json!({"model_ref":MODEL,"credential_id":credential,"default_quality":"invalid"}),
    )
    .await?;
    assert_eq!(rejected.error_code(), Some("image_model_quality_invalid"));
    assert_eq!(
        put(
            &s,
            json!({"model_ref":"openai/unknown","credential_id":credential})
        )
        .await?
        .error_code(),
        Some("image_model_unknown")
    );
    assert_eq!(
        put(&s, json!({"model_ref":MODEL,"credential_id":"missing"}))
            .await?
            .error_code(),
        Some("image_model_credential_invalid")
    );
    assert_eq!(
        put(&s, json!({"model_ref":MODEL,"credential_id":credential}))
            .await?
            .status,
        200
    );
    s.agent.terminate().await?;
    s.gw = s.agent.start_again().await?;
    let view = s.gw.get("/settings/image-model").await?;
    assert_eq!(view.data()["selected"]["credential_id"], credential);
    assert_eq!(view.data()["selected"]["default_quality"], "high");
    let chat = s.gw.get("/model-catalog").await?;
    assert_eq!(chat.status, 200, "{}", chat.text);
    for image in models {
        let id = image["model_ref"].as_str().unwrap();
        assert!(
            !chat.data().to_string().contains(id),
            "image in chat catalog: {id}"
        );
        let register = s.gw.post("/model-catalog/registered-models",json!({"provider_id":image["provider_id"],"model_id":image["model_id"],"auth_type":"api_key","credential_id":credential})).await?;
        assert_eq!(register.status, 400, "{}", register.text);
    }
    assert_eq!(
        s.gw.delete(&format!("/credentials/{credential}"))
            .await?
            .status,
        200
    );
    assert!(s.gw.get("/settings/image-model").await?.data()["selected"]["credential_id"].is_null());
    assert_eq!(put(&s, json!({"selected":null})).await?.status, 200);
    assert!(s.gw.get("/settings/image-model").await?.data()["selected"].is_null());
    s.finish().await
}
fn png(width: u32, height: u32, color: u8) -> Vec<u8> {
    let image = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        width,
        height,
        image::Rgba([color, 20, 30, 100]),
    ));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
    bytes.into_inner()
}
async fn generated(
    s: &Scenario,
    session: &str,
    bytes: &[u8],
    parent: Option<&str>,
) -> Result<String, HarnessError> {
    let reply = s.gw.post("/internal/e2e/images/generated",json!({"session":session,"data":STANDARD.encode(bytes),"parent_id":parent,"model_ref":MODEL})).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data()["id"].as_str().unwrap().to_owned())
}
async fn raw(s: &Scenario, path: &str) -> Result<reqwest::Response, HarnessError> {
    Ok(s.gw
        .http()
        .get(format!("{}{path}", s.gw.base))
        .bearer_auth(&s.gw.token)
        .send()
        .await?)
}
async fn mask(
    s: &Scenario,
    session: &str,
    id: &str,
    bytes: Vec<u8>,
) -> Result<reqwest::Response, HarnessError> {
    Ok(s.gw
        .http()
        .post(format!(
            "{}/message-assets/masks?session={session}&for={id}",
            s.gw.base
        ))
        .bearer_auth(&s.gw.token)
        .header("content-type", "image/png")
        .body(bytes)
        .send()
        .await?)
}
#[tokio::test]
async fn lossless_alpha_masks_and_three_version_lifetimes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("IMAGE-ASSETS")?.start().await?;
    for keep in [false, true] {
        let chat =
            s.gw.post("/sessions", json!({"kind":"chat","title":"Images"}))
                .await?;
        assert_eq!(chat.status, 201, "{}", chat.text);
        let session = chat.data()["session"]["id"].as_str().unwrap();
        let original = png(128, 96, if keep { 1 } else { 2 });
        let root = generated(&s, session, &original, None).await?;
        let child = generated(
            &s,
            session,
            &png(128, 96, if keep { 3 } else { 4 }),
            Some(&root),
        )
        .await?;
        let last = generated(
            &s,
            session,
            &png(128, 96, if keep { 5 } else { 6 }),
            Some(&child),
        )
        .await?;
        let response = raw(&s, &format!("/message-assets/{root}?download=1")).await?;
        assert_eq!(response.status(), 200);
        assert!(
            response.headers()["content-disposition"]
                .to_str()
                .unwrap()
                .starts_with("attachment;")
        );
        assert_eq!(response.bytes().await?.as_ref(), original);
        let response = raw(&s, &format!("/message-assets/{root}?w=32")).await?;
        assert_eq!(response.headers()["content-type"], "image/png");
        let resized = image::load_from_memory(&response.bytes().await?).unwrap();
        assert_eq!(resized.width(), 32);
        assert!(resized.color().has_alpha());
        assert_eq!(
            mask(&s, session, &root, png(64, 64, 0)).await?.status(),
            400
        );
        let masked = mask(&s, session, &root, png(128, 96, 0)).await?;
        assert_eq!(masked.status(), 200);
        let masked: Value = masked.json().await?;
        let mask_id = masked["data"]["id"].as_str().unwrap();
        assert_eq!(
            s.gw.get(&format!("/message-assets/{mask_id}/meta"))
                .await?
                .data()["kind"],
            "mask"
        );
        let versions =
            s.gw.get(&format!("/message-assets/{child}/versions"))
                .await?;
        assert_eq!(
            versions
                .data()
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [&root, &child, &last]
        );
        let meta = s.gw.get(&format!("/message-assets/{last}/meta")).await?;
        assert_eq!(meta.data()["model_ref"], MODEL);
        if keep {
            let saved = s.gw.post("/library",json!({"id":"image-version","kind":"scrap","title":"Saved edit","asset_id":last,"crop":format!("data:image/jpeg;base64,{}",STANDARD.encode(include_bytes!("../browser_outputs/pixel.jpg"))),"url":"https://example.com/","text":"Edit","capturedAt":"2026-10-25T00:00:00Z"})).await?;
            assert_eq!(saved.status, 200, "{}", saved.text);
        }
        let deleted =
            s.gw.delete(&format!("/sessions/{session}?permanent=true"))
                .await?;
        assert_eq!(deleted.status, 200, "{}", deleted.text);
        for id in [&root, &child, &last] {
            assert_eq!(
                raw(&s, &format!("/message-assets/{id}")).await?.status(),
                if keep { 200 } else { 404 }
            );
        }
        assert_eq!(
            raw(&s, &format!("/message-assets/{mask_id}"))
                .await?
                .status(),
            404
        );
        if keep {
            assert_eq!(s.gw.delete("/library/image-version").await?.status, 200);
        }
        assert_eq!(
            s.gw.post("/internal/e2e/images/sweep", json!({}))
                .await?
                .status,
            200
        );
        let asset_dir = s.sandbox.data.join("app-server/assets");
        let files = std::fs::read_dir(&asset_dir)?
            .map(|d| std::fs::read_dir(d.unwrap().path()).unwrap().count())
            .sum::<usize>();
        assert_eq!(files, 0, "lineage files were not swept");
    }
    s.finish().await
}
#[tokio::test]
async fn image_usage_counts_prices_unknown_cost_and_ranges() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("IMAGE-USAGE")?.start().await?;
    let now = chrono::Utc::now();
    for (model, provider, op, images, age, quality, text, input, output) in [
        (
            MODEL,
            "openai",
            "generate",
            2,
            0,
            "high",
            Some(1000),
            Some(2000),
            Some(3000),
        ),
        (
            MODEL,
            "openai",
            "edit",
            1,
            0,
            "high",
            Some(1000),
            None,
            Some(1000),
        ),
        (
            MODEL,
            "openai",
            "generate",
            7,
            8,
            "high",
            Some(1000),
            None,
            Some(1000),
        ),
        (
            "google/gemini-nano-banana-2.1",
            "google",
            "generate",
            2,
            0,
            "1K",
            None,
            None,
            None,
        ),
    ] {
        let row = json!({"ts":(now-chrono::Duration::days(age)).to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"model_ref":model,"provider_id":provider,"op":op,"images":images,"quality":quality,"input_text_tokens":text,"input_image_tokens":input,"output_image_tokens":output});
        assert_eq!(
            s.gw.post("/internal/e2e/images/usage", row).await?.status,
            200
        );
    }
    let stats = s.gw.get("/usage/images?days=7").await?;
    assert_eq!(stats.status, 200, "{}", stats.text);
    assert_eq!(stats.data()["total"]["generated"], 4);
    assert_eq!(stats.data()["total"]["edited"], 1);
    assert_eq!(stats.data()["models"][0]["model_ref"], MODEL);
    assert!((stats.data()["total"]["estimated_usd"].as_f64().unwrap() - 0.2132).abs() < 1e-9);
    assert_eq!(
        s.gw.get("/usage/images?days=30").await?.data()["total"]["generated"],
        11
    );
    assert_eq!(s.gw.get("/usage/images?days=14").await?.status, 400);
    let unknown = json!({"ts":now.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"model_ref":"retired/image","provider_id":"retired","op":"edit","images":1,"quality":null,"input_text_tokens":null,"input_image_tokens":null,"output_image_tokens":null});
    assert_eq!(
        s.gw.post("/internal/e2e/images/usage", unknown)
            .await?
            .status,
        200
    );
    let stats = s.gw.get("/usage/images?days=7").await?;
    assert!(stats.data()["total"]["estimated_usd"].is_null());
    assert_eq!(stats.data()["total"]["edited"], 2);
    s.finish().await
}
