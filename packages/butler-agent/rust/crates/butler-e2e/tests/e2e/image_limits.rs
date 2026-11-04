//! A catalog model without published dimension limits still reads images;
//! Butler's own decode and byte limits keep refusing harmful images.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "test assertions")]

use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use butler_e2e::e2e::config::ModelChoice;
use butler_e2e::e2e::gateway::turn_state;
use butler_e2e::e2e::provider::Script;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_e2e::e2e::{HarnessError, media};
use serde_json::{Value, json};

/// A runnable image model whose catalog entry has no width, height or pixel cap.
const MODEL: &str = "openai/gpt-6.1-sol";

#[tokio::test]
async fn image_limits_absent_catalog_dimensions_deliver_and_decode_limits_refuse()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    assert_dimension_limits_absent(MODEL);
    let s = Setup::new("IMAGE-LIMITS")?
        .model(ModelChoice {
            model: MODEL.into(),
            effort: Some("low".into()),
        })
        .synthetic(Script {
            rounds: 0,
            path_for: Box::new(|_| String::new()),
            final_text: "Image received.".into(),
        })
        .start()
        .await?;
    let upload =
        s.gw.upload(
            "number.png",
            "image/png",
            &media::digits_png("4821", 12),
            Some("general"),
        )
        .await?;
    assert_eq!(upload.status, 201, "{}", upload.text);
    let sent = send_image(&s, &upload.data()["file"]["file_id"]).await?;
    assert_eq!(sent.status, 202, "{}", sent.text);
    let terminal =
        s.gw.wait_terminal(
            "general",
            &s.gw.accepted_turn(sent.data()).await?,
            Duration::from_secs(15),
        )
        .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let requests = s.provider()?.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["model"], MODEL.split_once('/').unwrap().1);
    let images: Vec<_> = requests[0]["input"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|m| m["content"].as_array().into_iter().flatten())
        .filter(|part| part["type"] == "input_image")
        .collect();
    assert_eq!(images.len(), 1);
    assert_png_projection(&images[0]["image_url"]);
    assert_decode_refusals(&s).await?;
    assert_eq!(
        s.provider()?.requests().len(),
        1,
        "a refused image was sent"
    );
    s.finish().await
}

fn assert_dimension_limits_absent(model_ref: &str) {
    let catalog: Value = serde_json::from_str(include_str!(
        "../../../butler-models/src/models/catalog/static-catalog.json"
    ))
    .unwrap();
    let model = catalog["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["model_ref"] == model_ref)
        .unwrap();
    assert_eq!(model["image_input_support"], "supported");
    for field in ["image_max_width", "image_max_height", "image_max_pixels"] {
        assert!(model.get(field).is_none(), "{model_ref} has {field}");
    }
}

async fn send_image(
    s: &Scenario,
    file_id: &Value,
) -> Result<butler_e2e::e2e::gateway::Reply, HarnessError> {
    s.gw.post(
        "/messages",
        json!({"chat_id":"general","text":"Read this image.",
            "attachments":[{"file_id":file_id}],
            "client_message_id":uuid::Uuid::new_v4().to_string()}),
    )
    .await
}

async fn assert_decode_refusals(s: &Scenario) -> Result<(), HarnessError> {
    for (name, png) in [
        ("too-wide.png", media::png_claiming(16_385, 1)),
        ("too-tall.png", media::png_claiming(1, 16_385)),
        ("too-many-pixels.png", media::png_claiming(8_001, 8_000)),
    ] {
        let upload =
            s.gw.upload(name, "image/png", &png, Some("general"))
                .await?;
        assert_eq!(upload.status, 201, "{name}: {}", upload.text);
        let sent = send_image(s, &upload.data()["file"]["file_id"]).await?;
        assert_eq!(sent.status, 413, "{name}: {}", sent.text);
        assert_eq!(
            sent.error_code(),
            Some("image_payload_invalid"),
            "{name}: {}",
            sent.text
        );
    }
    let mut oversized = media::digits_png("1", 1);
    oversized.resize(10 * 1024 * 1024 + 1, 0);
    let upload =
        s.gw.upload("too-large.png", "image/png", &oversized, Some("general"))
            .await?;
    assert_eq!(upload.status, 413, "{}", upload.text);
    assert_eq!(upload.error_code(), Some("message_file_too_large"));
    Ok(())
}

fn assert_png_projection(url: &Value) {
    let encoded = url
        .as_str()
        .unwrap()
        .strip_prefix("data:image/png;base64,")
        .unwrap();
    let png = STANDARD.decode(encoded).unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
}

#[tokio::test]
async fn chat_tool_images_follow_parallel_tool_results() -> Result<(), HarnessError> {
    use butler_e2e::e2e::fake_servers::{ChatBehavior, FakeServer, LocalCapabilities};
    use butler_e2e::e2e::security::AdminClient;
    use reqwest::Method;

    butler_e2e::gate!();
    let calls = json!([
        {"id":"observe","type":"function","function":{"name":"browser_observe",
            "arguments":json!({"tab":"t1","look":"always"}).to_string()}},
        {"id":"read","type":"function","function":{"name":"read_file",
            "arguments":json!({"requests":[{"path":"sample.txt"}]}).to_string()}}
    ]);
    let server = FakeServer::local_models(ChatBehavior {
        script: vec![
            json!({"role":"assistant","content":null,"tool_calls":calls}),
            json!({"role":"assistant","content":"Finished."}),
        ],
        refuse_stream: true,
        local_capabilities: LocalCapabilities {
            ollama: Some(vec!["completion".into(), "tools".into(), "vision".into()]),
            ..Default::default()
        },
        ..Default::default()
    })
    .await?;
    let s = super::setup_local_models::with_local_server("CHAT-TOOL-IMAGE-ORDER", &server).await?;
    super::setup_local_models::use_local_model(&s, &server.base_url).await?;
    s.patch_settings(
        json!({"browser":{"browsing_agent":"off"}}),
        "direct browser tools",
    )
    .await?;
    std::fs::write(s.sandbox.data.join("sample.txt"), "File contents")?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let registered = admin
        .send(
            Method::POST,
            "/internal/browser-host/events",
            Some(json!({"tabs":[{
                "id":"t1","owner":"conversation:general","profile":"signed_out","epoch":1,
                "holder":"agent","inUse":false,"url":"https://example.com/"
            }]})),
            &[],
        )
        .await?;
    assert_eq!(registered.status, 200, "{}", registered.text);
    let pixels = STANDARD.encode(include_bytes!("browser_outputs/pixel.jpg"));
    let image = pixels.clone();
    let host = async move {
        let mut buffer = String::new();
        loop {
            let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
            if frame["op"] != "tab.observe" {
                continue;
            }
            assert_eq!(frame["args"]["include_image"], true);
            let reply = admin
                .send(
                    Method::POST,
                    &format!(
                        "/internal/browser-host/results/{}",
                        frame["id"].as_str().unwrap()
                    ),
                    Some(
                        json!({"status":"ok","tab":"t1","obs":"o1","text":"Page text",
                    "url":"https://example.com/","image":{"mime_type":"image/jpeg","data":image}}),
                    ),
                    &[],
                )
                .await?;
            assert_eq!(reply.status, 200, "{}", reply.text);
            return Ok::<_, HarnessError>(());
        }
    };
    let (turn, served) = tokio::join!(s.turn("general", "Read the page and file."), host);
    served?;
    assert_eq!(turn_state(&turn?.1), "delivered");
    let requests = server.chat_requests();
    let messages = requests
        .iter()
        .rev()
        .find(|r| r["stream"] != true && r["tools"].is_array())
        .unwrap()["messages"]
        .as_array()
        .unwrap();
    let index = messages
        .iter()
        .position(|m| m["tool_calls"] == calls)
        .unwrap();
    assert_eq!(messages[index]["role"], "assistant");
    for (offset, id) in [(1, "observe"), (2, "read")] {
        assert_eq!(messages[index + offset]["role"], "tool");
        assert_eq!(messages[index + offset]["tool_call_id"], id);
    }
    assert_eq!(
        messages[index + 3],
        json!({"role":"user","content":[{
            "type":"image_url","image_url":{"url":format!("data:image/jpeg;base64,{pixels}")}
        }]})
    );
    s.finish().await
}
