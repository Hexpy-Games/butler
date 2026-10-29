use super::*;
#[tokio::test]
async fn auto_and_full_access_generate_losslessly_and_record_cost() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for access in [Access::Auto, Access::FullAccess] {
        let f = Fixture::start(access, "openai").await?;
        f.script("Make a picture", vec![generate("gen")]);
        f.run("Make a picture").await?;
        let output = f.output("gen");
        assert_eq!(output["schema"], "butler.image.v1", "{output}");
        assert_eq!(output["status"], "ok");
        assert!(output["parent"].is_null());
        assert_eq!(output["width"], 128);
        assert_eq!(f.image.requests().len(), 1);
        assert_eq!(f.image.requests()[0].path, "/v1/images/generations");
        assert_eq!(f.image.requests()[0].json["output_format"], "png");
        let id = output["image"].as_str().unwrap();
        assert_eq!(
            f.raw(&format!("/message-assets/{id}")).await?,
            f.image.bytes()
        );
        let url = output["url"].as_str().unwrap();
        assert!(url.contains("signature="), "{output}");
        let meta = f.s.gw.get(&format!("/message-assets/{id}/meta")).await?;
        assert_eq!(meta.data()["img"], id);
        assert!(
            meta.data()["image_url"]
                .as_str()
                .unwrap()
                .contains("signature=")
        );
        let stats = f.s.gw.get("/usage/images?days=7").await?;
        assert_eq!(stats.data()["total"]["generated"], 1);
        assert!((stats.data()["total"]["estimated_usd"].as_f64().unwrap() - 0.00141).abs() < 1e-10);
        assert_eq!(f.s.gw.approval_requests("general").await?, [] as [Value; 0]);
        f.script(
            "Make this picture brighter",
            vec![call(
                "same-bytes-edit",
                "edit_image",
                &json!({"image":id,"prompt":"Make it brighter"}),
            )],
        );
        f.run("Make this picture brighter").await?;
        let edited = f.output("same-bytes-edit");
        assert_eq!(edited["parent"], id);
        assert_ne!(
            edited["image"], id,
            "an identical provider image still creates a new version"
        );
        let versions =
            f.s.gw
                .get(&format!("/message-assets/{id}/versions"))
                .await?;
        assert_eq!(versions.data().as_array().unwrap().len(), 2);
        f.finish().await?;
    }
    Ok(())
}
#[tokio::test]
async fn asking_tiers_show_exact_facts_and_denial_never_dispatches() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for access in [Access::AskAlways, Access::AskExceptReads] {
        for decision in ["allow", "deny"] {
            let f = Fixture::start(access, "openai").await?;
            let prompt = "A very complete visual prompt. ".repeat(100);
            f.script(
                "Draw",
                vec![call(
                    "approval",
                    "generate_image",
                    &json!({"prompt":prompt,"size":"1024x1024","quality":"high","images":[]}),
                )],
            );
            let id = paused(&f.s, "general", "Draw").await?;
            let cards = f.s.gw.approval_requests("general").await?;
            assert_eq!(cards.len(), 1);
            let approval = &cards[0]["approval"];
            assert_eq!(approval["action_kind"], "generate_image");
            assert_eq!(approval["risk"], "high");
            assert_eq!(
                approval["operation"]["image"],
                json!({"action":"generate","model":"GPT Image 2.5 Sunburst","model_ref":MODEL,"size":"1024x1024","quality":"high","images":[],"mask":null,"prompt":prompt})
            );
            assert!(f.image.requests().is_empty());
            approve(&f.s, "general", decision).await?;
            delivered(&f.s, "general", &id).await?;
            assert_eq!(f.image.requests().len(), usize::from(decision == "allow"));
            if decision == "deny" {
                assert!(f.output("approval").to_string().contains("denied"));
            }
            f.finish().await?;
        }
    }
    Ok(())
}
#[tokio::test]
async fn unselected_and_read_only_hide_and_refuse_forced_calls() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for selected in [false, true] {
        let f = Fixture::start(Access::Auto, "openai").await?;
        if !selected {
            f.s.gw
                .send(
                    reqwest::Method::PUT,
                    "/settings/image-model",
                    Some(json!({"selected":null}).to_string()),
                )
                .await?;
        }
        f.script("Forced picture", vec![generate("forced")]);
        let reply=f.s.gw.post("/messages",json!({"chat_id":"general","text":"Forced picture","client_message_id":uuid::Uuid::new_v4().to_string(),"access_mode":if selected{"read_only"}else{"auto"}})).await?;
        let id = f.s.gw.accepted_turn(reply.data()).await?;
        delivered(&f.s, "general", &id).await?;
        for request in f.script.requests.lock().unwrap().iter() {
            assert!(
                !request["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|t| t["name"] == "generate_image" || t["name"] == "edit_image")
            );
        }
        assert!(f.image.requests().is_empty());
        assert_eq!(f.output("forced")["error"]["code"], "tool_unavailable");
        f.finish().await?;
    }
    Ok(())
}
#[tokio::test]
async fn provider_errors_return_message_once_without_assets_or_usage() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for status in [400, 500] {
        let f = Fixture::start(Access::Auto, "openai").await?;
        f.image
            .fail(status, "The image provider declined this prompt.");
        f.script("Fail picture", vec![generate("failed")]);
        f.run("Fail picture").await?;
        let output = f.output("failed");
        assert_eq!(
            output["error"]["message"],
            "The image provider declined this prompt."
        );
        assert_eq!(f.image.requests().len(), 1);
        let stats = f.s.gw.get("/usage/images?days=7").await?;
        assert_eq!(stats.data()["total"]["generated"], 0);
        assert!(output["image"].is_null());
        assert_eq!(f.stored_images().await?, 0);
        f.finish().await?;
    }
    Ok(())
}
