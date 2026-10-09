//! Pixels use the existing visual carrier; reply crops use journal closeout artifacts.
use super::super::GuidedTools;
use base64::{Engine, engine::general_purpose::STANDARD};
use butler_turn::btcc::ToolExecutionError;
use serde_json::{Value, json};

pub(in crate::host::guided::tools) async fn finish(
    owner: &GuidedTools,
    name: &str,
    result: &mut Value,
) -> Result<(), ToolExecutionError> {
    let Some(image) = result.get("image") else {
        return Ok(());
    };
    let bytes = image["data"]
        .as_str()
        .filter(|raw| raw.len() <= 205 * 1024)
        .and_then(|raw| STANDARD.decode(raw).ok())
        .filter(|bytes| {
            image["mime_type"] == "image/jpeg"
                && bytes.len() <= 150 * 1024
                && bytes.starts_with(&[0xff, 0xd8])
        });
    let Some(bytes) = bytes else {
        result.as_object_mut().map(|value| value.remove("image"));
        result["image_status"] = json!("invalid_image");
        return Ok(());
    };
    if name == "browser_observe" {
        let mut state = owner.state.lock();
        if state.visual_image_bytes + bytes.len() > 2 * 1024 * 1024 {
            result.as_object_mut().map(|value| value.remove("image"));
            result["image_status"] = json!("image_budget_exhausted");
        } else {
            state.visual_image_bytes += bytes.len();
        }
    } else if name == "browser_screenshot" && result["status"] == "ok" {
        result.as_object_mut().map(|value| value.remove("image"));
        let path = format!("artifacts/public-data/browser-{}.jpg", uuid::Uuid::new_v4());
        let target = owner.binding.butler_data.join(&path);
        let size = bytes.len();
        let saved = tokio::task::spawn_blocking(move || {
            butler_platform::secure_fs::create_private_dir_all(
                target
                    .parent()
                    .ok_or_else(|| std::io::Error::other("invalid_capture_path"))?,
            )?;
            butler_platform::secure_fs::replace_private(
                &target,
                |file| std::io::Write::write_all(file, &bytes),
                |error| error,
            )
        })
        .await;
        if matches!(saved, Ok(Ok(()))) {
            result["artifacts"] = json!([{"path":path,"kind":"image",
                "mime_type":"image/jpeg","size_bytes":size}]);
        } else {
            *result = json!({"status":"unknown","reason":"capture_write_failed"});
        }
    }
    Ok(())
}
