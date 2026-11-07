//! The one loader of the pictures the shell shows from the agent: message files
//! (`useMessageFileSource`) and answer assets (`/message-assets`). Each picture is downloaded
//! once, on the agent worker, and kept; the transcript, the files rows and the viewer share it.
use std::collections::HashMap;
use std::sync::Arc;

use gpui::{App, Image, ImageFormat};

use crate::ui::source::agent::Jobs;

/// Which picture, and where the agent serves it from.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum PictureId {
    /// `GET /message-files/{id}`
    File(String),
    /// `GET /message-assets/{id}`
    Asset(String),
}

/// Where one picture stands.
enum Load {
    Pending,
    Ready(Arc<Image>),
    Failed,
}

#[derive(Default)]
struct Pictures(HashMap<PictureId, Load>);

impl gpui::Global for Pictures {}

/// The loaded picture; starts its download the first time it is asked for while an agent is
/// attached. The windows refresh when it arrives.
pub(crate) fn picture(id: &PictureId, cx: &mut App) -> Option<Arc<Image>> {
    match cx.default_global::<Pictures>().0.get(id) {
        Some(Load::Ready(image)) => return Some(image.clone()),
        Some(Load::Pending | Load::Failed) => return None,
        None => {}
    }
    Jobs::client(cx)?;
    cx.default_global::<Pictures>()
        .0
        .insert(id.clone(), Load::Pending);
    let (key, wanted) = (id.clone(), id.clone());
    let done = Jobs::run(cx, move |client| async move {
        let (content_type, bytes) = match wanted {
            PictureId::File(id) => {
                let file = client.download_message_file(&id).await.ok()?;
                (file.content_type, file.bytes)
            }
            PictureId::Asset(id) => {
                let file = client.download_message_asset(&id, false).await.ok()?;
                (file.content_type, file.bytes)
            }
        };
        Some((content_type, bytes))
    });
    cx.spawn(async move |cx| {
        let loaded = done.await;
        cx.update(|cx| {
            let pictures = cx.default_global::<Pictures>();
            match loaded {
                Some(download) => {
                    let state = download
                        .and_then(|(content_type, bytes)| decode(content_type.as_deref(), bytes))
                        .map_or(Load::Failed, Load::Ready);
                    pictures.0.insert(key, state);
                }
                // The agent detached before the download ended: ask again after the next attach.
                None => {
                    pictures.0.remove(&key);
                }
            }
        });
        cx.refresh();
    })
    .detach();
    None
}

/// True while the picture's download runs.
pub(crate) fn is_pending(id: &PictureId, cx: &mut App) -> bool {
    matches!(cx.default_global::<Pictures>().0.get(id), Some(Load::Pending))
}

/// The picture a download carries, by its content type.
fn decode(content_type: Option<&str>, bytes: Vec<u8>) -> Option<Arc<Image>> {
    let mime = content_type?.split(';').next()?.trim();
    let format = ImageFormat::from_mime_type(mime)?;
    Some(Arc::new(Image::from_bytes(format, bytes)))
}
