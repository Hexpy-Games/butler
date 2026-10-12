//! Source image bytes fetched through the observed tab's network session.
use super::{capture, collect_crop, page::Page, scripts::scripts};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
const SOURCE: &str =
    include_str!("../../../../../../../butler-app/client/electron/browser/page/collect-image.mjs");

pub(crate) async fn collect(page: &Page, args: &Value) -> Result<Value, String> {
    let epoch = page.epoch().ok_or("tab_closed")?;
    let observation = page
        .shared
        .with_tab(&page.tab, |t| t.observation.clone())
        .flatten()
        .ok_or("stale_ref")?;
    let mut args = args.clone();
    if args["observation"].is_null() {
        args["observation"] = json!(observation.obs);
    }
    if observation.epoch != epoch || args["observation"] != observation.obs {
        return Ok(json!({"status":"refused","reason":"stale_ref"}));
    }
    if args["region"].is_array() {
        return collect_crop::capture(page, &args, epoch).await;
    }
    let frame = if let Some(reference) = args["ref"].as_str() {
        observation.frame_of(reference).ok_or("stale_ref")?
    } else {
        observation.frames.first().ok_or("frame_unavailable")?
    };
    if let Some(refused) = check_ref(page, frame, &args, epoch).await? {
        return Ok(refused);
    }
    let function = SOURCE.replacen("export ", "", 1);
    let source = page
        .evaluate(
            frame,
            &format!(
                "({function})({})",
                json!({"ref":args["ref"],"url":args["url"],"obs":args["observation"],"epoch":epoch})
            ),
        )
        .await?;
    if source["reason"].is_string() {
        return Ok(json!({"status":"refused","reason":source["reason"]}));
    }
    if source["image"].is_object() {
        if page.epoch() != Some(epoch) {
            return Err("control_changed".into());
        }
        let mut result = source;
        result["status"] = json!("ok");
        return Ok(result);
    }
    let url = source["source_url"].as_str().unwrap_or("");
    if url.is_empty() {
        let mut crop = capture::screenshot(page, &args).await?;
        crop["alt"] = source["alt"].clone();
        crop["nearby_text"] = source["nearby_text"].clone();
        return Ok(crop);
    }
    if args["url"].is_string() {
        return Ok(
            json!({"status":"ok","source_url":url,"alt":source["alt"],"nearby_text":source["nearby_text"]}),
        );
    }
    let bytes = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        network_image(page, frame, url),
    )
    .await
    .map_err(|_| "image_timeout")??;
    if page.epoch() != Some(epoch) {
        return Ok(json!({"status":"refused","reason":"control_changed"}));
    }
    Ok(
        json!({"status":"ok","source_url":url,"alt":source["alt"],"nearby_text":source["nearby_text"],"image":{"data":STANDARD.encode(bytes)}}),
    )
}
async fn network_image(
    page: &Page,
    frame: &super::state::Frame,
    url: &str,
) -> Result<Vec<u8>, String> {
    let response = page.send_to(&frame.session, "Network.loadNetworkResource", json!({"frameId":frame.id,"url":url,"options":{"disableCache":false,"includeCredentials":true}})).await?;
    let resource = &response["resource"];
    let stream = resource["stream"].as_str().ok_or("image_fetch_failed")?;
    let result = read_stream(page, &frame.session, stream, resource).await;
    let _ = page
        .send_to(&frame.session, "IO.close", json!({"handle":stream}))
        .await;
    result
}
async fn read_stream(
    page: &Page,
    session: &str,
    stream: &str,
    resource: &Value,
) -> Result<Vec<u8>, String> {
    if resource["success"] != true
        || !resource["headers"].as_object().is_some_and(|h| {
            h.iter().any(|(k, v)| {
                k.eq_ignore_ascii_case("content-type")
                    && v.as_str().is_some_and(|m| m.starts_with("image/"))
            })
        })
    {
        return Err("invalid_image".into());
    }
    let mut bytes = Vec::new();
    loop {
        let chunk = page
            .send_to(session, "IO.read", json!({"handle":stream,"size":65536}))
            .await?;
        let data = chunk["data"].as_str().ok_or("image_fetch_failed")?;
        let raw = if chunk["base64Encoded"] == true {
            STANDARD.decode(data).map_err(|_| "invalid_image")?
        } else {
            data.as_bytes().to_vec()
        };
        if bytes.len() + raw.len() > crate::browser::MAX_IMAGE_DOWNLOAD {
            return Err("image_too_large".into());
        }
        bytes.extend_from_slice(&raw);
        if chunk["eof"] == true {
            return Ok(bytes);
        }
    }
}

async fn check_ref(
    page: &Page,
    frame: &super::state::Frame,
    args: &Value,
    epoch: u64,
) -> Result<Option<Value>, String> {
    if args["ref"].is_string() {
        let resolved = page
            .evaluate(
                frame,
                &scripts()
                    .ok_or("scripts_unavailable")?
                    .resolve(&json!({"ref":args["ref"],"obs":args["observation"],"epoch":epoch})),
            )
            .await?;
        if resolved["reason"].is_string() {
            return Ok(Some(
                json!({"status":"refused","reason":resolved["reason"]}),
            ));
        }
    }
    Ok(None)
}
