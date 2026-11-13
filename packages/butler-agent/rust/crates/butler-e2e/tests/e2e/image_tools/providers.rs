use super::*;

#[tokio::test]
async fn xai_and_qwen_generate_and_edit_with_provider_wires() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (provider, model, size) in [
        ("xai", "xai/grok-imagine-image-2.0", "1:1"),
        ("qwen", "qwen/qwen-image-3.0", "1024x1024"),
    ] {
        let f = Fixture::start(Access::Auto, "openai").await?;
        let key =
            f.s.gw
                .post(
                    "/credentials",
                    json!({"provider_id":provider,"api_key":"provider-image-stub"}),
                )
                .await?;
        assert_eq!(key.status, 201, "{}", key.text);
        let selected =
            f.s.gw
                .send(
                    reqwest::Method::PUT,
                    "/settings/image-model",
                    Some(
                        json!({"model_ref":model,"credential_id":key.data()["credential"]["id"]})
                            .to_string(),
                    ),
                )
                .await?;
        assert_eq!(selected.status, 200, "{}", selected.text);
        f.script(
            "Draw a kite",
            vec![call(
                "provider-gen",
                "generate_image",
                &json!({"prompt":"A red kite","size":size}),
            )],
        );
        f.run("Draw a kite").await?;
        let generated = f.output("provider-gen");
        assert_eq!(generated["status"], "ok", "{generated}");
        let image = generated["image"].as_str().unwrap();
        assert_eq!(
            f.raw(&format!("/message-assets/{image}")).await?,
            f.image.bytes()
        );
        f.script(
            "Edit the kite",
            vec![call(
                "provider-edit",
                "edit_image",
                &json!({"image":image,"prompt":"Make it blue","size":size}),
            )],
        );
        f.run("Edit the kite").await?;
        let edited = f.output("provider-edit");
        assert_eq!(edited["status"], "ok", "{edited}");
        let id = edited["image"].as_str().unwrap();
        assert_eq!(
            f.raw(&format!("/message-assets/{id}")).await?,
            f.image.bytes()
        );
        let requests = f.image.requests();
        assert_eq!(requests.len(), 2);
        if provider == "xai" {
            assert_eq!(requests[0].path, "/v1/images/generations");
            assert_eq!(requests[0].json["aspect_ratio"], size);
            assert_eq!(requests[0].json["resolution"], "1k");
            assert_eq!(requests[1].path, "/v1/images/edits");
            assert!(
                requests[1].json["images"][0]["url"]
                    .as_str()
                    .unwrap()
                    .starts_with("data:image/")
            );
        } else {
            assert!(
                requests
                    .iter()
                    .all(|r| r.path == "/compatible-mode/v1/images/generations"
                        && r.json.get("quality").is_none())
            );
            assert!(
                requests[1].json["image"][0]
                    .as_str()
                    .unwrap()
                    .starts_with("data:image/")
            );
        }
        f.finish().await?;
    }
    Ok(())
}
