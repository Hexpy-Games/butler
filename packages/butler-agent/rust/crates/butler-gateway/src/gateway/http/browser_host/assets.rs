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
    if op != "tab.image_collect" || result["status"] != "ok" {
        return Ok(());
    }
    let source_url = result["source_url"]
        .as_str()
        .or_else(|| result["url"].as_str())
        .unwrap_or("")
        .to_owned();
    let pixels = result.as_object_mut().and_then(|o| o.remove("image"));
    let bytes = if let Some(pixels) = pixels {
        pixels["data"]
            .as_str()
            .filter(|raw| raw.len() <= 12 * 1024 * 1024)
            .and_then(|raw| STANDARD.decode(raw).ok())
            .ok_or("invalid_image")
    } else {
        butler_runtime::browser::fetch_image(&source_url).await
    };
    let bytes = match bytes {
        Ok(bytes) => bytes,
        Err(reason) => {
            *result = json!({"status":"refused","reason":reason});
            return Ok(());
        }
    };
    let command = AppAssetCommand::Collect {
        session: session.into(),
        bytes,
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
    Ok(())
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
