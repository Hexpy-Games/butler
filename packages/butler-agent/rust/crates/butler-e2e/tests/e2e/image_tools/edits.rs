use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
fn png(mask: bool) -> Vec<u8> {
    let image = image::RgbaImage::from_fn(128, 128, |x, y| {
        if mask {
            image::Rgba([
                0,
                0,
                0,
                if (24..104).contains(&x) && (24..104).contains(&y) {
                    0
                } else {
                    255
                },
            ])
        } else {
            image::Rgba([11, 22, 33, 44])
        }
    });
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .unwrap();
    bytes.into_inner()
}
async fn source(f: &Fixture) -> Result<(String, String), HarnessError> {
    let reply =
        f.s.gw
            .post(
                "/internal/e2e/images/generated",
                json!({"session":"general","data":STANDARD.encode(png(false)),"model_ref":MODEL}),
            )
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    let image = reply.data()["id"].as_str().unwrap().to_owned();
    let response =
        f.s.gw
            .http()
            .post(format!(
                "{}/message-assets/masks?session=general&for={image}",
                f.s.gw.base
            ))
            .bearer_auth(&f.s.gw.token)
            .header("content-type", "image/png")
            .body(png(true))
            .send()
            .await?;
    assert_eq!(response.status(), 200);
    let mask: Value = response.json().await?;
    Ok((image, mask["data"]["id"].as_str().unwrap().into()))
}
#[tokio::test]
async fn editor_authorizes_once_and_composites_for_both_providers() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for provider in ["openai", "google"] {
        let f = Fixture::start(Access::AskAlways, provider).await?;
        let (image, mask) = source(&f).await?;
        let args = json!({"image":image,"mask":mask,"prompt":"Paint the centre gold"});
        f.script(
            "Edit this picture",
            vec![
                call("first-edit", "edit_image", &args),
                call("second-edit", "edit_image", &args),
            ],
        );
        let sent=f.s.gw.post("/messages",json!({"chat_id":"general","text":"Edit this picture","image_edit":{"image":image,"mask":mask},"client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
        let turn = f.s.gw.accepted_turn(sent.data()).await?;
        let waiting =
            f.s.gw
                .wait_turn(
                    "general",
                    &turn,
                    &["waiting_for_form", "failed", "delivered"],
                    std::time::Duration::from_secs(30),
                )
                .await?;
        assert_eq!(
            butler_e2e::e2e::gateway::turn_state(&waiting),
            "waiting_for_form",
            "{waiting}\n{}",
            f.s.agent.logs()
        );
        assert_eq!(f.image.requests().len(), 1);
        let request = &f.image.requests()[0];
        if provider == "openai" {
            assert_eq!(request.path, "/v1/images/edits");
            assert!(
                request
                    .parts
                    .iter()
                    .any(|(name, bytes)| name == "image[]" && *bytes == png(false))
            );
            assert!(
                request
                    .parts
                    .iter()
                    .any(|(name, bytes)| name == "mask" && *bytes == png(true))
            );
            assert!(
                !request
                    .parts
                    .iter()
                    .any(|(name, _)| name == "input_fidelity")
            );
        } else {
            assert_eq!(request.path, "/v1beta/interactions");
            let input = request.json["input"].as_array().unwrap();
            assert_eq!(input.len(), 2);
            assert!(
                input[0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("19% to 81% across and 19% to 81% down")
            );
            assert_eq!(request.json["response_format"]["aspect_ratio"], "1:1");
        }
        let output = f.output("first-edit");
        assert_eq!(output["status"], "ok", "{output}");
        assert_eq!(output["parent"], image);
        let id = output["image"].as_str().unwrap();
        let bytes = f.raw(&format!("/message-assets/{id}")).await?;
        let result = image::load_from_memory(&bytes).unwrap().to_rgba8();
        let original = image::load_from_memory(&png(false)).unwrap().to_rgba8();
        for (x, y, pixel) in result.enumerate_pixels() {
            if !(24..104).contains(&x) || !(24..104).contains(&y) {
                assert_eq!(pixel, original.get_pixel(x, y));
            }
        }
        assert_eq!(result.get_pixel(64, 64), &image::Rgba([201, 202, 203, 204]));
        let versions =
            f.s.gw
                .get(&format!("/message-assets/{id}/versions"))
                .await?;
        let rows = versions.data().as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], image);
        assert!(rows.iter().all(
            |r| r["img"] == r["id"] && r["image_url"].as_str().unwrap().contains("signature=")
        ));
        let cards = f.s.gw.approval_requests("general").await?;
        assert_eq!(cards.len(), 1);
        assert_eq!(
            cards[0]["approval"]["operation"]["image"]["images"],
            json!([image])
        );
        assert_eq!(cards[0]["approval"]["operation"]["image"]["mask"], mask);
        approve(&f.s, "general", "deny").await?;
        delivered(&f.s, "general", &turn).await?;
        // A later user turn edits the explicitly selected latest version.
        f.script(
            "Make it brighter",
            vec![call(
                "followup",
                "edit_image",
                &json!({"image":id,"prompt":"Make it brighter"}),
            )],
        );
        let turn = paused(&f.s, "general", "Make it brighter").await?;
        approve(&f.s, "general", "allow").await?;
        delivered(&f.s, "general", &turn).await?;
        assert_eq!(f.output("followup")["parent"], id);
        f.finish().await?;
    }
    Ok(())
}
#[tokio::test]
async fn attached_images_import_losslessly_as_original_parents() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let f = Fixture::start(Access::Auto, "openai").await?;
    let bytes = png(false);
    let upload =
        f.s.gw
            .upload("source.png", "image/png", &bytes, Some("general"))
            .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let file = upload.data()["file"]["file_id"].as_str().unwrap();
    f.script(
        "Edit uploaded picture",
        vec![call(
            "attached",
            "edit_image",
            &json!({"image":file,"prompt":"Paint it gold"}),
        )],
    );
    let sent = f.s.gw.post("/messages", json!({"chat_id":"general","text":"Edit uploaded picture","attachments":[{"file_id":file}],"client_message_id":uuid::Uuid::new_v4().to_string()})).await?;
    let turn = f.s.gw.accepted_turn(sent.data()).await?;
    delivered(&f.s, "general", &turn).await?;
    let output = f.output("attached");
    assert_eq!(output["status"], "ok", "{output}");
    let parent = output["parent"].as_str().unwrap();
    let meta =
        f.s.gw
            .get(&format!("/message-assets/{parent}/meta"))
            .await?;
    assert_eq!(meta.data()["kind"], "original");
    assert_eq!(f.raw(&format!("/message-assets/{parent}")).await?, bytes);
    f.finish().await
}
