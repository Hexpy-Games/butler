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
        let registered =
            f.s.gw
                .post(
                    "/settings/image-model/registered",
                    json!({"model_ref":model,"credential_id":key.data()["credential"]["id"]}),
                )
                .await?;
        assert_eq!(registered.status, 200, "{}", registered.text);
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

#[tokio::test]
async fn legacy_image_selection_is_registered_without_rewrite() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let image = ImageServer::start().await?;
    let (url, script, chat) = stub::start().await?;
    let mut s = Setup::new("IMAGE-LEGACY")?
        .access(Access::Auto)
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", format!("{url}/v1"))
        .env("OPENAI_BASE_URL", format!("{}/v1", image.base))
        .start()
        .await?;
    let key =
        s.gw.post(
            "/credentials",
            json!({"provider_id":"openai","api_key":"legacy-image-key"}),
        )
        .await?;
    assert_eq!(key.status, 201, "{}", key.text);
    s.agent.terminate().await?;
    let path = s.sandbox.data.join("butler.config.json");
    let credential = key.data()["credential"]["id"].clone();
    let before = tokio::task::spawn_blocking(move || {
        let mut config: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        config["user"]["imageModel"] =
            json!({"model_ref":"openai/gpt-image-2","credential_id":credential});
        config["user"]
            .as_object_mut()
            .unwrap()
            .remove("imageModels");
        let bytes = serde_json::to_vec(&config)?;
        std::fs::write(&path, &bytes)?;
        Ok::<_, HarnessError>((path, bytes))
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    s.gw = s.agent.start_again().await?;
    let f = Fixture {
        s,
        script,
        image,
        chat,
    };
    let settings = f.s.gw.get("/settings/image-model").await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    assert_eq!(settings.data()["registered"], json!(["openai/gpt-image-2"]));
    assert_eq!(
        settings.data()["selected"]["model_ref"],
        "openai/gpt-image-2"
    );
    assert_eq!(
        settings.data()["selected"]["credential_id"],
        key.data()["credential"]["id"]
    );
    assert_eq!(std::fs::read(before.0)?, before.1);
    f.script(
        "Legacy image",
        vec![call(
            "legacy-gen",
            "generate_image",
            &json!({"prompt":"A red kite"}),
        )],
    );
    f.run("Legacy image").await?;
    let generated = f.output("legacy-gen");
    assert_eq!(generated["status"], "ok", "{generated}");
    assert_eq!(
        f.raw(&format!(
            "/message-assets/{}",
            generated["image"].as_str().unwrap()
        ))
        .await?,
        f.image.bytes()
    );
    let cleared =
        f.s.gw
            .send(
                reqwest::Method::PUT,
                "/settings/image-model",
                Some(json!({"selected":null}).to_string()),
            )
            .await?;
    assert_eq!(cleared.status, 200, "{}", cleared.text);
    let settings = f.s.gw.get("/settings/image-model").await?;
    assert_eq!(settings.status, 200, "{}", settings.text);
    assert!(settings.data()["selected"].is_null());
    assert_eq!(settings.data()["registered"], json!(["openai/gpt-image-2"]));
    f.finish().await
}
