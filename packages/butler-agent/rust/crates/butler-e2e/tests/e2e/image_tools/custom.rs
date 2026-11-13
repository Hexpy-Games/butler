use super::*;

#[tokio::test]
async fn custom_openai_image_model_uses_vault_and_deletes_selection() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let f = Fixture::start(Access::Auto, "openai").await?;
    let key = "custom-image-stub-secret";
    let added =
        f.s.gw
            .post(
                "/settings/image-model/custom",
                json!({
                    "display_name":"Custom image", "api_base_url":format!("{}/v1",f.image.base),
                    "model_id":"image-model", "api_key":key
                }),
            )
            .await?;
    assert_eq!(added.status, 200, "{}", added.text);
    let model_ref = added.data()["selected"]["model_ref"]
        .as_str()
        .unwrap()
        .to_owned();
    f.script(
        "Draw custom kite",
        vec![call(
            "custom-gen",
            "generate_image",
            &json!({"prompt":"A red kite"}),
        )],
    );
    f.run("Draw custom kite").await?;
    let generated = f.output("custom-gen");
    assert_eq!(generated["status"], "ok", "{generated}");
    let image = generated["image"].as_str().unwrap();
    assert_eq!(
        f.raw(&format!("/message-assets/{image}")).await?,
        f.image.bytes()
    );
    let requests = f.image.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "/v1/images/generations");
    assert_eq!(
        requests[0].authorization.as_deref(),
        Some(format!("Bearer {key}").as_str())
    );
    assert!(requests[0].json.get("quality").is_none());
    let settings = f.s.gw.get("/settings/image-model").await?;
    assert!(!settings.text.contains(key));
    let custom = settings.data()["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["model_ref"] == model_ref)
        .unwrap();
    assert_eq!(custom["credentials"][0]["masked_value"], "cus...t");
    let id = model_ref.strip_prefix("custom-image/").unwrap();
    let deleted =
        f.s.gw
            .send(
                reqwest::Method::DELETE,
                &format!("/settings/image-model/custom/{id}"),
                None,
            )
            .await?;
    assert_eq!(deleted.status, 200, "{}", deleted.text);
    assert!(deleted.data()["selected"].is_null());
    f.finish().await
}
