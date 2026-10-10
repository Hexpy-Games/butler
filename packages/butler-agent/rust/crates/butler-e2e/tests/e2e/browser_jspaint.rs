//! Authentic Luna replay of the owner's normal conversation; no live network.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;

const REQUEST: &str = "https://jspaint.app/#local:b4cea4b918ade 에서 마우스로 집 한 채와 해를 그려줘. 다 그리면 그림을 캡처해서 보여줘.";

#[tokio::test]
async fn luna_jspaint_replays_point_strokes_pixels_attachment_and_release()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    assert_clean_cassette();
    let s = Setup::new("BROWSER-JSPAINT")?
        .cassette("BROWSER-JSPAINT")
        .start()
        .await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    let host = tokio::spawn(serve_host(stream, admin));
    s.turn("general", REQUEST).await?;
    match tokio::time::timeout(Duration::from_secs(30), host).await {
        Ok(result) => result.unwrap()?,
        Err(_) => {
            eprintln!(
                "Provider requests before replay stall: {}",
                s.provider()?.requests().len()
            );
            s.finish().await?;
            return Err(butler_e2e::e2e::harness_error(
                "native replay did not finish",
            ));
        }
    }
    let messages = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let messages = s.gw.messages("general").await?;
            if messages.iter().any(|m| {
                m["role"] == "assistant"
                    && m["attachments"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|a| a["kind"] == "image"))
            }) {
                break Ok::<_, HarnessError>(messages);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .unwrap()?;
    assert!(messages.iter().any(|m| {
        m["attachments"].as_array().is_some_and(|a| {
            a.iter().any(|a| {
                a["kind"] == "image"
                    && a["mime_type"] == "image/jpeg"
                    && a["size_bytes"].as_u64().unwrap() > 0
            })
        })
    }));
    assert!(
        messages
            .iter()
            .any(|m| m["text"].as_str().is_some_and(|text| text.contains("![")))
    );
    assert_pixel_requests(&s.provider()?.requests());
    s.finish().await
}

fn assert_clean_cassette() {
    let root = butler_e2e::e2e::cassette::root().join("BROWSER-JSPAINT");
    for entry in std::fs::read_dir(root).unwrap() {
        let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        assert!(
            butler_e2e::e2e::sanitize::lint(&text).is_empty(),
            "JSPaint cassette contains no secrets or raw identifiers"
        );
    }
}

fn assert_pixel_requests(requests: &[Value]) {
    let mut seen = std::collections::HashSet::new();
    let mut images = 0;
    let mut captures = 0;
    for request in requests {
        for item in request["input"].as_array().unwrap() {
            if item["type"] != "function_call_output"
                || !seen.insert(item["call_id"].as_str().unwrap().to_owned())
            {
                continue;
            }
            let Some(parts) = item["output"].as_array() else {
                continue;
            };
            let result: Value = serde_json::from_str(
                parts.iter().find(|p| p["type"] == "input_text").unwrap()["text"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            if result["output"]["schema"] == "butler.browser-capture.v1"
                && result["output"]["status"] == "ok"
            {
                assert!(parts.iter().any(|p| p["type"] == "input_image"));
                assert!(result["output"]["source_observation"].is_string());
                assert!(
                    result["output"]["next"]
                        .as_str()
                        .unwrap()
                        .contains("retain the pictured page state")
                );
                assert_eq!(
                    result["output"]["untrusted_content"]["fields"]
                        .as_array()
                        .unwrap()
                        .len(),
                    0
                );
                captures += 1;
            }
            if result["output"]["schema"] != "butler.browser-observation.v1"
                || result["output"]["status"] != "ok"
            {
                continue;
            }
            assert!(
                parts.iter().any(|p| p["type"] == "input_image"
                    && p["image_url"]
                        .as_str()
                        .is_some_and(|url| url.starts_with("data:image/jpeg;base64,"))),
                "every fresh observation must reach the model as pixels"
            );
            images += 1;
        }
    }
    assert_eq!(
        images,
        recorded_calls()
            .iter()
            .filter(|call| call["frame"]["op"] == "tab.observe" && call["result"]["status"] == "ok")
            .count(),
        "all recorded native observations, with no lost images"
    );
    assert_eq!(
        captures, 1,
        "the actual reply crop reaches the model for review"
    );
}

async fn serve_host(mut stream: reqwest::Response, admin: AdminClient) -> Result<(), HarnessError> {
    let calls = recorded_calls();
    assert_pointer_recording(&calls);
    let mut buffer = String::new();
    let mut active = std::collections::HashSet::new();
    for recorded in &calls {
        let frame = loop {
            let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
            if frame["op"] == "use.started" {
                active.insert(frame["id"].as_str().unwrap().to_owned());
                continue;
            }
            if frame["op"] == "use.ended" {
                assert!(active.remove(frame["args"]["id"].as_str().unwrap()));
                continue;
            }
            if frame["op"] == "use.finished" {
                assert!(active.is_empty());
                continue;
            }
            break frame;
        };
        assert_eq!(frame["session"], "general");
        assert_eq!(frame["op"], recorded["frame"]["op"]);
        if frame["op"] == "tab.observe" {
            assert_eq!(frame["args"]["include_image"], true);
        }
        for key in [
            "url",
            "steps",
            "observation",
            "ref",
            "region",
            "scope",
            "look",
        ] {
            assert_eq!(
                frame["args"][key], recorded["frame"]["args"][key],
                "replayed native {key}"
            );
        }
        if frame["op"] == "tab.open" {
            let tab = json!({"id":recorded["result"]["tab"],"owner":"conversation:general","profile":"signed_out","epoch":1,"holder":"agent","inUse":false,"url":recorded["result"]["url"]});
            admin
                .send(
                    Method::POST,
                    "/internal/browser-host/events",
                    Some(json!({"tabs":[tab]})),
                    &[],
                )
                .await?;
        }
        let response = admin
            .send(
                Method::POST,
                &format!(
                    "/internal/browser-host/results/{}",
                    frame["id"].as_str().unwrap()
                ),
                Some(recorded["result"].clone()),
                &[],
            )
            .await?;
        assert_eq!(response.status, 200);
    }
    loop {
        let frame = super::browser_delegation::next_frame(&mut stream, &mut buffer).await?;
        if frame["op"] == "use.ended" {
            assert!(active.remove(frame["args"]["id"].as_str().unwrap()));
        } else {
            assert_eq!(frame["op"], "use.finished");
            assert!(active.is_empty());
            break;
        }
    }
    Ok(())
}

fn recorded_calls() -> Vec<Value> {
    let text = include_str!("../../fixtures/browser-route/jspaint-host.json");
    assert!(
        butler_e2e::e2e::sanitize::lint(text).is_empty(),
        "host fixture contains no secrets"
    );
    serde_json::from_str(text).unwrap()
}

fn assert_pointer_recording(calls: &[Value]) {
    let acts: Vec<_> = calls
        .iter()
        .filter(|call| call["frame"]["op"] == "tab.act")
        .collect();
    let drags: Vec<_> = acts
        .iter()
        .flat_map(|call| call["frame"]["args"]["steps"].as_array().unwrap())
        .filter(|step| step["action"] == "drag")
        .collect();
    assert!(
        drags.len() >= 4,
        "walls, separate roof segments and sun use native drags"
    );
    assert_eq!(
        drags
            .iter()
            .map(|s| json!([s["point"], s["target_point"]]))
            .collect::<Vec<_>>(),
        vec![
            json!([[210, 220], [330, 320]]),
            json!([[210, 220], [270, 165]]),
            json!([[270, 165], [330, 220]]),
            json!([[400, 65], [465, 130]])
        ],
        "recorded wall rectangle, connected roof segments and separate sun"
    );
    for drag in drags {
        assert!(drag["point"].is_array() && drag["target_point"].is_array());
        assert!(
            drag["ref"].is_null(),
            "canvas strokes use screenshot points"
        );
    }
    assert!(
        acts.iter().any(|call| call["result"]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|step| step["hit"]["role"] == "element")),
        "toolbar/palette picks use native clicks"
    );
    assert_tool_and_palette_picks(&acts);
    let capture = calls
        .iter()
        .find(|call| call["frame"]["op"] == "tab.screenshot")
        .unwrap();
    assert_eq!(capture["result"]["status"], "ok");
    assert_eq!(
        capture["frame"]["args"]["region"],
        json!([49, 20, 546, 307]),
        "crop retains the whole visible drawing canvas"
    );
    assert!(
        capture["frame"]["args"]["region"].is_array()
            || capture["frame"]["args"]["ref"].is_string(),
        "final attachment is a canvas crop"
    );
}

fn assert_tool_and_palette_picks(acts: &[&Value]) {
    let picks: Vec<_> = acts
        .iter()
        .flat_map(|call| call["frame"]["args"]["prepared_steps"].as_array().unwrap())
        .filter(|step| step["action"] == "click" && step["hit"]["role"] == "element")
        .collect();
    for tool in ["Rectangle", "Line", "Ellipse"] {
        assert!(
            picks.iter().any(|step| step["hit"]["name"] == tool),
            "native {tool} toolbar selection"
        );
    }
    assert!(
        picks.iter().any(|step| step["rect"]["y"] == 737.5
            && step["rect"]["width"] == 15
            && step["rect"]["height"] == 15),
        "an actual palette swatch is clicked, not only the color preview"
    );
}
