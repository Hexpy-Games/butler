use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

#[tokio::test]
async fn offered_choices_follow_the_selected_image_model() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let f = Fixture::start(Access::Auto, "openai").await?;
    for (provider, model) in [
        ("openai", MODEL),
        ("google", "google/gemini-nano-banana-2.1"),
    ] {
        let key =
            f.s.gw
                .post(
                    "/credentials",
                    json!({"provider_id":provider,"api_key":"schema-stub-key"}),
                )
                .await?;
        let settings =
            f.s.gw
                .send(
                    reqwest::Method::PUT,
                    "/settings/image-model",
                    Some(
                        json!({
                            "model_ref":model,"credential_id":key.data()["credential"]["id"]
                        })
                        .to_string(),
                    ),
                )
                .await?;
        assert_eq!(settings.status, 200, "{}", settings.text);
        let settings = settings.data();
        let capability = settings["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["model_ref"] == model)
            .unwrap();
        let prompt = format!("Check the image choices for {provider}");
        f.run(&prompt).await?;
        let requests = f.script.requests_for(&prompt);
        let tools = requests[0]["tools"].as_array().unwrap();
        for name in ["generate_image", "edit_image"] {
            let tool = tools.iter().find(|t| t["name"] == name).unwrap();
            for (key, choices) in [("size", "sizes"), ("quality", "qualities")] {
                let property = &tool["parameters"]["properties"][key];
                assert_eq!(property["enum"], capability[choices]);
                let description = property["description"].as_str().unwrap();
                for choice in capability[choices].as_array().unwrap() {
                    assert!(
                        description.contains(choice.as_str().unwrap()),
                        "{description}"
                    );
                }
            }
        }
    }
    assert!(f.image.requests().is_empty());
    f.finish().await
}

#[tokio::test]
async fn truncated_body_is_transport_but_complete_bad_json_is_invalid() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let f = Fixture::start(Access::Auto, "google").await?;
    for (truncated, code) in [(true, "image_transport"), (false, "image_response_invalid")] {
        // HTTP 200, then the body connection breaks after an image-sized prefix.
        f.image.respond(vec![b' '; 2_310_144], truncated);
        let id = if truncated { "truncated" } else { "invalid" };
        f.script(
            id,
            vec![call(
                id,
                "generate_image",
                &json!({"prompt":"A red kite","size":"1:1","quality":"1K"}),
            )],
        );
        f.run(id).await?;
        let output = f.output(id);
        assert_eq!(output["error"]["code"], code, "{output}");
        assert_eq!(
            output["error"]["retryable"],
            if truncated { json!(true) } else { Value::Null }
        );
        assert!(output["image"].is_null());
    }
    assert_eq!(f.image.requests().len(), 2, "no implicit billed retries");
    assert_eq!(f.stored_images().await?, 0);
    let stats = f.s.gw.get("/usage/images?days=7").await?;
    assert_eq!(stats.data()["total"]["generated"], 0);
    f.finish().await
}

#[tokio::test]
async fn complete_large_image_response_is_consumed_losslessly() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let f = Fixture::start(Access::Auto, "google").await?;
    let bytes = tokio::task::spawn_blocking(|| {
        let mut seed = 42_u32;
        let pixels = image::RgbaImage::from_fn(1024, 1024, |_, _| {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            image::Rgba(seed.to_le_bytes())
        });
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(pixels)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        bytes.into_inner()
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?;
    let body = json!({"steps":[{"type":"model_output","content":[
        {"type":"image","data":STANDARD.encode(&bytes)}
    ]}]})
    .to_string()
    .into_bytes();
    assert!(body.len() > 4 * 1024 * 1024);
    f.image.respond(body, false);
    f.script(
        "Large picture",
        vec![call("large", "generate_image", &json!({"prompt":"A kite"}))],
    );
    f.run("Large picture").await?;
    let output = f.output("large");
    assert_eq!(output["status"], "ok", "{output}");
    let id = output["image"].as_str().unwrap();
    assert_eq!(f.raw(&format!("/message-assets/{id}")).await?, bytes);
    assert_eq!(f.image.requests().len(), 1);
    assert_eq!(f.stored_images().await?, 1);
    f.finish().await
}
