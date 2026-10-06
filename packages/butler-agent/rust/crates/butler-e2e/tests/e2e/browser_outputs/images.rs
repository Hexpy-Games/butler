//! The real model request receives JPEG pixels only after visual admission.
use super::stub;
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_e2e::e2e::{HarnessError, scenario::Setup, security::AdminClient};
use reqwest::Method;
use serde_json::{Value, json};

#[tokio::test]
async fn output_check_images_are_visual_and_capped_per_turn() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let s = Setup::new("OUTPUT-IMAGES")?
        .stub_cassette(stub::cassette()?)
        .start()
        .await?;
    s.turn("general", "Publish").await?;
    let admin = AdminClient::new(s.gw.clone(), s.agent.launch.admin_credential().unwrap());
    let mut stream = reqwest::Client::new()
        .get(format!("{}/internal/browser-host", s.gw.base))
        .bearer_auth(&s.gw.token)
        .header("x-butler-admin", &admin.admin)
        .send()
        .await?;
    assert_eq!(stream.status(), 200);
    let host = tokio::spawn(async move {
        let mut buffer = String::new();
        for _ in 0..3 {
            loop {
                if let Some(end) = buffer.find("\n\n") {
                    let event = buffer[..end].to_owned();
                    buffer.drain(..end + 2);
                    if let Some(data) = event.lines().find_map(|l| l.strip_prefix("data: ")) {
                        let frame: Value = serde_json::from_str(data).unwrap();
                        assert_eq!(frame["args"]["include_image"], true);
                        let report = json!({"status":"ok","url":frame["args"]["url"],"title":"Image","load_ms":10,"errors":{"total":0,"shown":[]},"layout":{"blank":false,"overflow_px":{"desktop":0,"mobile":0}},"warnings":[],"image":{"mime_type":"image/jpeg","data":STANDARD.encode(include_bytes!("pixel.jpg"))}});
                        let reply = admin
                            .send(
                                Method::POST,
                                &format!(
                                    "/internal/browser-host/results/{}",
                                    frame["id"].as_str().unwrap()
                                ),
                                Some(report),
                                &[],
                            )
                            .await
                            .unwrap();
                        assert_eq!(reply.status, 200);
                        break;
                    }
                } else {
                    let chunk = stream.chunk().await.unwrap().unwrap();
                    buffer.push_str(std::str::from_utf8(&chunk).unwrap());
                }
            }
        }
    });
    let (turn, _) = s.turn("general", "Images").await?;
    let requests = s.provider()?.requests();
    let expected = format!(
        "data:image/jpeg;base64,{}",
        STANDARD.encode(include_bytes!("pixel.jpg"))
    );
    assert!(include_bytes!("pixel.jpg").len() > 50 * 1024);
    let visual = requests
        .iter()
        .filter(|r| {
            r["input"].as_array().is_some_and(|items| {
                items.iter().any(|item| {
                    item["output"].as_array().is_some_and(|parts| {
                        parts.iter().any(|part| {
                            part["type"] == "input_image" && part["image_url"] == expected
                        })
                    })
                })
            })
        })
        .count();
    assert!(visual >= 3, "no visual tool output in provider requests");
    let db = butler_platform::sqlite::open_with_flags(
        s.sandbox.data.join("agent-runtime/btcc.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let raw: String = db.query_row("SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='output_check' AND turn_id=?1 ORDER BY started_at DESC,rowid DESC LIMIT 1",[&turn],|r|r.get(0)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&raw).unwrap()["status"],
        "budget_exhausted"
    );
    drop(db);
    host.await.unwrap();
    s.finish().await
}
