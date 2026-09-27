use axum::http::HeaderValue;
use std::{io, sync::Arc};

use axum::{
    body::{Body, Bytes},
    http::{Response, StatusCode, Uri, header},
};
use futures_util::stream;

use super::{HttpError, HttpState};
use crate::gateway::{TranscriptExport, protocol::APP_PROTOCOL_VERSION};

pub(super) async fn get(state: Arc<HttpState>, uri: &Uri) -> Result<Response<Body>, HttpError> {
    let query = super::query(uri);
    let session_id = query
        .get("session_id")
        .or_else(|| query.get("sessionId"))
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| HttpError::public(400, "session_required", "Session id is required."))?;
    let export = state.application.export_transcript(session_id).await?;
    let stream = stream::unfold(ResponseState::new(export), |mut state| async move {
        loop {
            match state.phase {
                Phase::Prefix => {
                    state.phase = Phase::Chunks;
                    return Some((Ok(Bytes::from(state.prefix())), state));
                }
                Phase::Chunks => match state.export.chunks.recv().await {
                    Some(Ok(chunk)) => {
                        state.message_count += chunk.message_count;
                        let escaped = json(&chunk.text);
                        return Some((
                            Ok(Bytes::from(escaped[1..escaped.len() - 1].to_owned())),
                            state,
                        ));
                    }
                    Some(Err(_)) => {
                        state.phase = Phase::Done;
                        return Some((Err(io::Error::other("transcript export failed")), state));
                    }
                    None => state.phase = Phase::Suffix,
                },
                Phase::Suffix => {
                    state.phase = Phase::Done;
                    return Some((Ok(Bytes::from(state.suffix())), state));
                }
                Phase::Done => return None,
            }
        }
    });
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

enum Phase {
    Prefix,
    Chunks,
    Suffix,
    Done,
}

struct ResponseState {
    export: TranscriptExport,
    phase: Phase,
    message_count: usize,
}

impl ResponseState {
    fn new(export: TranscriptExport) -> Self {
        Self {
            export,
            phase: Phase::Prefix,
            message_count: 0,
        }
    }

    fn prefix(&self) -> String {
        format!(
            "{{\"protocol_version\":{},\"data\":{{\"session_id\":{},\"format\":{},\"filename\":{},\"content\":\"",
            json(APP_PROTOCOL_VERSION),
            json(&self.export.session_id),
            json(&self.export.format),
            json(&self.export.filename),
        )
    }

    fn suffix(&self) -> String {
        format!(
            "\",\"message_count\":{},\"generated_at\":{}}}}}",
            self.message_count,
            json(&self.export.generated_at),
        )
    }
}

fn json(value: &str) -> String {
    serde_json::Value::from(value).to_string()
}
