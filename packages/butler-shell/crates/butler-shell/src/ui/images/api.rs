//! `imageApi.ts` and the output readers of `useImageOutputs.ts`: picture sources, the frame
//! shape of a picture, and the reads that run on the agent worker.
use butler_ds::ui::media_frame::Aspect;
use butler_shell_client::ShellClient;
use gpui::{App, ImageSource};
use serde_json::Value;

use super::ImageAsset;
use crate::ui::shell::image_viewer::loader::{PictureId, picture};

/// `imageAspect`: the frame shape nearest the picture's, by log-ratio so portrait and landscape
/// deviations weigh the same.
pub(super) fn aspect(width: u32, height: u32) -> Aspect {
    let ratio = if width > 0 && height > 0 {
        f64::from(width) / f64::from(height)
    } else {
        1.
    };
    let distance = |aspect: Aspect| (ratio / f64::from(aspect.ratio())).ln().abs();
    [
        Aspect::Square,
        Aspect::FourFive,
        Aspect::ThreeFour,
        Aspect::SixteenTen,
        Aspect::SixteenNine,
    ]
    .into_iter()
    .fold(Aspect::Square, |best, next| {
        if distance(next) < distance(best) {
            next
        } else {
            best
        }
    })
}

/// `assetSource`: the picture once the shared loader has it (the load starts on the first ask).
/// The loader serves the original; the `?w=` resize of React's source is not asked for.
pub(super) fn loaded(id: &str, cx: &mut App) -> Option<ImageSource> {
    picture(&PictureId::Asset(id.to_owned()), cx).map(ImageSource::Image)
}

/// `outputImages` and `toolFailed` in one walk: the `butler.image.v1` pictures an output names
/// and whether any part of it reports a failure. Strings are read as JSON when they parse.
fn visit(value: &Value, images: &mut Vec<String>, failed: &mut bool) {
    match value {
        Value::String(text) => {
            if let Ok(inner) = serde_json::from_str::<Value>(text) {
                visit(&inner, images, failed);
            }
        }
        Value::Object(map) => {
            if map.get("ok") == Some(&Value::Bool(false))
                || map.get("status").and_then(Value::as_str) == Some("error")
            {
                *failed = true;
            }
            if map.get("schema").and_then(Value::as_str) == Some("butler.image.v1")
                && let Some(image) = map.get("image").and_then(Value::as_str)
            {
                images.push(image.to_owned());
                return;
            }
            for inner in map.values() {
                visit(inner, images, failed);
            }
        }
        Value::Array(items) => {
            for inner in items {
                visit(inner, images, failed);
            }
        }
        _ => {}
    }
}

/// `readOutput`: the operation's output in pages until it is complete.
async fn read_output(client: &ShellClient, turn: &str, call: &str, result: &str) -> Option<String> {
    let (mut content, mut offset) = (String::new(), 0u64);
    loop {
        let page = client
            .get_operation_output(turn, call, result, offset)
            .await
            .ok()?;
        content.push_str(page.get("content")?.as_str()?);
        if page.get("complete")?.as_bool()? {
            return Some(content);
        }
        let end = page.get("byte_end")?.as_u64()?;
        if end <= offset {
            return None;
        }
        offset = end;
    }
}

/// `GET /message-assets/{id}/meta`
pub(super) async fn read_meta(client: &ShellClient, id: &str) -> Option<ImageAsset> {
    let meta = client.get_message_asset_meta(id).await.ok()?;
    serde_json::from_value(meta).ok()
}

/// One tool call's pictures and whether its output reports a failure; `None` when the output
/// or a picture's meta could not be read.
pub(super) async fn read_call(
    client: &ShellClient,
    turn: &str,
    call: &str,
    result: &str,
) -> Option<(Vec<ImageAsset>, bool)> {
    let content = read_output(client, turn, call, result).await?;
    let (mut ids, mut failed) = (Vec::new(), false);
    visit(&Value::String(content), &mut ids, &mut failed);
    let metas = futures::future::join_all(ids.iter().map(|id| read_meta(client, id))).await;
    let images = metas.into_iter().collect::<Option<Vec<_>>>()?;
    Some((images, failed))
}
