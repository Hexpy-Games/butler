//! A result's screenshot is kept once, as a message file of the conversation.
//! The pixels stay in the result for the model; transcript copies name the
//! file (`image.file`) instead of repeating its base64.
use super::{HttpError, HttpState};
use serde_json::Value;

/// Screenshots larger than this were never admitted as model images.
const MAX_SHOT: usize = 150 * 1024;

pub(super) async fn store(
    state: &HttpState,
    session: &str,
    result: &mut Value,
) -> Result<(), HttpError> {
    use base64::Engine;
    let Some(image) = result.get_mut("image").and_then(Value::as_object_mut) else {
        return Ok(());
    };
    if image.get("mime_type").and_then(Value::as_str) != Some("image/jpeg") {
        return Ok(());
    }
    let Some(bytes) = image
        .get("data")
        .and_then(Value::as_str)
        .and_then(|raw| base64::engine::general_purpose::STANDARD.decode(raw).ok())
        .filter(|bytes| bytes.len() <= MAX_SHOT)
    else {
        return Ok(());
    };
    // Without a file the pixels simply stay inline, as before.
    let Ok(file) = state
        .application
        .upload_message_file(crate::gateway::AppFileUpload {
            browser_tab: None,
            owner_session_id: Some(session.into()),
            name: "browser-observation.jpg".into(),
            mime_type: Some("image/jpeg".into()),
            bytes: bytes.into(),
        })
        .await
    else {
        return Ok(());
    };
    image.insert(
        "file".into(),
        serde_json::to_value(file).map_err(|_| HttpError::Internal)?,
    );
    Ok(())
}
