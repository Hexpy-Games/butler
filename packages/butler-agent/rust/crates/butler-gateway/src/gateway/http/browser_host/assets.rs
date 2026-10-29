//! Finish browser collection before pixels cross back to model context.
use super::{HttpError, HttpState};
use crate::gateway::AppAssetCommand;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
pub(super) async fn finish(
    state: &HttpState,
    session: &str,
    op: &str,
    result: &mut Value,
) -> Result<(), HttpError> {
    if op != "tab.image_collect" {
        return Ok(());
    }
    if result["status"] != "ok" {
        explain_refusal(result);
        return Ok(());
    }
    let source_url = result["source_url"]
        .as_str()
        .or_else(|| result["url"].as_str())
        .unwrap_or("")
        .to_owned();
    let bytes = collected_source(result, &source_url).await;
    let (bytes, pixel_ratio) = match bytes {
        Ok(bytes) => bytes,
        Err(reason) => {
            *result = json!({"status":"refused","reason":reason});
            explain_refusal(result);
            return Ok(());
        }
    };
    let command = AppAssetCommand::Collect {
        session: session.into(),
        bytes,
        pixel_ratio,
        alt: result["alt"].as_str().unwrap_or("").into(),
        nearby_text: result["nearby_text"].as_str().unwrap_or("").into(),
        source_url,
    };
    match state.application.assets(command).await {
        Ok(asset) => *result = asset,
        Err(crate::gateway::GatewayApplicationError::Public {
            status: 400, code, ..
        }) => *result = json!({"status":"refused","reason":code}),
        Err(_) => *result = json!({"status":"refused","reason":"asset_store_failed"}),
    }
    explain_refusal(result);
    Ok(())
}
async fn collected_source(
    result: &mut Value,
    source_url: &str,
) -> Result<(Vec<u8>, f64), &'static str> {
    let pixels = result.as_object_mut().and_then(|o| o.remove("image"));
    let rendered = pixels.map(|pixels| {
        pixels["data"]
            .as_str()
            .filter(|raw| raw.len() <= 12 * 1024 * 1024)
            .and_then(|raw| STANDARD.decode(raw).ok())
            .ok_or("invalid_image")
    });
    let original = || async {
        if source_url.is_empty() {
            return Err("invalid_image");
        }
        butler_runtime::browser::fetch_image(
            source_url,
            result["referer"].as_str().unwrap_or(""),
            result["user_agent"].as_str().unwrap_or(""),
        )
        .await
    };
    let capture_ratio = result["pixel_ratio"]
        .as_f64()
        .filter(|r| r.is_finite() && *r > 0.0)
        .unwrap_or(1.0);
    let rendered = rendered.map(|bytes| bytes.map(|bytes| (bytes, capture_ratio)));
    match rendered {
        // A photo whose pixels the page withholds is collected from its own file
        // (full size, whatever covers it); its rendered crop is the fallback.
        Some(rendered) if result["fetch_source"] == true => match original().await {
            Ok(bytes) => match tokio::task::spawn_blocking(move || {
                butler_runtime::browser::normalize_image(&bytes).map(|_| bytes)
            })
            .await
            {
                Ok(Ok(bytes)) => Ok((bytes, 1.0)),
                _ => rendered,
            },
            Err(reason) => rendered.or(Err(reason)),
        },
        Some(rendered) => rendered,
        None => original().await.map(|bytes| (bytes, 1.0)),
    }
}

pub(super) async fn lookup(state: &HttpState, args: &Value) -> Result<Value, HttpError> {
    let ids = args["ids"]
        .as_array()
        .filter(|ids| ids.len() <= 512)
        .ok_or(HttpError::Internal)?
        .iter()
        .map(|id| id.as_str().map(str::to_owned).ok_or(HttpError::Internal))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(state
        .application
        .assets(AppAssetCommand::Lookup { ids })
        .await?)
}

pub(super) fn validate(op: &str, args: &Value) -> Result<(), HttpError> {
    if op == "tab.image_collect"
        && ["ref", "region", "url"]
            .iter()
            .filter(|key| !args[**key].is_null())
            .count()
            != 1
    {
        return Err(HttpError::public(
            400,
            "choose_one_source",
            "Choose ref, region or url.",
        ));
    }
    Ok(())
}

fn explain_refusal(result: &mut Value) {
    if result["status"] != "refused" || result["recovery"].is_string() {
        return;
    }
    let recovery = match result["reason"].as_str().unwrap_or("") {
        "stale_ref" => "Observe the tab again and use a fresh image ref.",
        "private_image_url" => {
            "URL downloads require a public address. Collect an already-loaded image by ref or visible region."
        }
        "image_too_large" => {
            "The source exceeds safe download or decode limits. Collect its loaded ref or a visible region."
        }
        "invalid_image" => {
            "The source is not a supported raster image. Collect its loaded ref or a visible region for browser-rendered pixels."
        }
        "image_access_denied" => {
            "The server denied this download (HTTP 401/403). Collect the image from a tab where it has loaded, by ref or visible region."
        }
        "image_not_found" => {
            "The source no longer exists (HTTP 404/410). Observe the page again and collect its current image ref."
        }
        "image_http_failed" => {
            "The image server returned an HTTP error. Collect an already-loaded image by ref or visible region."
        }
        "image_fetch_failed" | "image_timeout" => {
            "The image request failed or timed out. Open the page, wait for the image, then collect its ref or a visible region."
        }
        "image_redirect_limit" => {
            "The image redirected too many times. Open its page and collect the loaded image by ref."
        }
        "secure_field" => {
            "The capture overlaps a protected field. Choose an image or region without protected fields."
        }
        // Other refusals (a covered element, a timeout, a changed page) keep the
        // agent's per-reason recovery, which names one other source and when to
        // stop instead of a generic retry.
        _ => return,
    };
    result["recovery"] = json!(recovery);
}

/// Internal image asset operations are authenticated with the same local admin boundary.
pub(super) async fn image(
    state: &HttpState,
    session: &str,
    op: &str,
    args: &Value,
) -> Result<Value, HttpError> {
    use crate::gateway::{AppImageUsageCommand, GeneratedAssetKind};
    use base64::{Engine, engine::general_purpose::STANDARD};
    let mut data = match op {
        "images.resolve" => {
            state
                .application
                .assets(AppAssetCommand::ResolveInput {
                    session: session.into(),
                    id: args["id"].as_str().ok_or(HttpError::Internal)?.into(),
                    mask_for: args["mask_for"].as_str().map(str::to_owned),
                })
                .await?
        }
        "images.store" => {
            state
                .application
                .assets(AppAssetCommand::PutGenerated {
                    session: session.into(),
                    bytes: STANDARD
                        .decode(args["data"].as_str().ok_or(HttpError::Internal)?)
                        .map_err(|_| HttpError::invalid_json())?,
                    kind: GeneratedAssetKind::Generated,
                    parent_id: args["parent_id"].as_str().map(str::to_owned),
                    model_ref: args["model_ref"].as_str().map(str::to_owned),
                })
                .await?
        }
        "images.usage" => {
            state
                .application
                .image_usage(AppImageUsageCommand::Record(
                    serde_json::from_value(args.clone()).map_err(|_| HttpError::invalid_json())?,
                ))
                .await?
        }
        _ => return Err(HttpError::Internal),
    };
    if op == "images.store"
        && let Some(id) = data["id"].as_str().map(str::to_owned)
    {
        data["url"] = json!(format!("/message-assets/{id}"));
    }
    Ok(data)
}
