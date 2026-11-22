//! Stream finished canonical turns to the main over the authenticated remote socket.
use super::{HttpError, HttpState, query};
use axum::{
    body::Body,
    http::{Uri, header},
    response::{IntoResponse, Response},
};
use butler_turn::conversation::{ConversationSourceReader, TransferMark, conversation_store_path};
use futures_util::stream;
use serde::Serialize;
use tokio::sync::mpsc;

pub(super) fn get(state: &HttpState, uri: &Uri) -> Result<Response, HttpError> {
    let path = conversation_store_path(state.output_data.as_deref().ok_or(HttpError::Internal)?);
    let params = query(uri);
    let after = match (params.get("identity"), params.get("seq"), params.get("key")) {
        (None, None, None) => None,
        (Some(identity), Some(seq), Some(key)) => Some(TransferMark {
            identity: (!identity.is_empty()).then(|| identity.clone()),
            seq: seq.parse().map_err(|_| HttpError::invalid_json())?,
            key: key.clone(),
        }),
        _ => return Err(HttpError::invalid_json()),
    };
    let (sender, receiver) = mpsc::channel(4);
    tokio::task::spawn_blocking(move || {
        let end = match path.try_exists() {
            Ok(false) => Some(TransferMark {
                identity: None,
                seq: 0,
                key: String::new(),
            }),
            Ok(true) => ConversationSourceReader::open(&path)
                .and_then(|reader| reader.export_transfer(after, |turn| send_line(&sender, &turn)))
                .ok()
                .flatten(),
            Err(_) => None,
        };
        if let Some(mark) = end {
            send_line(&sender, &serde_json::json!({"end": mark}));
        }
    });
    let body = Body::from_stream(stream::unfold(receiver, |mut receiver| async move {
        let line = receiver.recv().await?;
        Some((Ok::<_, std::convert::Infallible>(line), receiver))
    }));
    Ok(([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response())
}

fn send_line(sender: &mpsc::Sender<Vec<u8>>, value: &impl Serialize) -> bool {
    let Ok(mut line) = serde_json::to_vec(value) else {
        return false;
    };
    line.push(b'\n');
    sender.blocking_send(line).is_ok()
}
