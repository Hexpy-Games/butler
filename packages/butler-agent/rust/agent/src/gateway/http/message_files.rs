//! Multipart upload and original-file HTTP responses over the App owner.

mod mime;

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{FromRequest, Multipart, multipart::MultipartError},
    http::{Method, Request, StatusCode, header},
    response::Response,
};
use bytes::BytesMut;
use serde_json::json;

use super::{HttpError, HttpState, MAX_REQUEST_BODY_SIZE, json, read_body_with_limit};
use crate::{
    gateway::{
        AppFileUpload,
        protocol::{APP_PROTOCOL_VERSION, ApiEnvelope},
    },
    public_text::trim_js_whitespace,
};

// Retain one extra byte to preserve App's size-error ordering after owner checks.
// The rest of the multipart body is still parsed, but never retained as a file.
const UPLOAD_RETAIN_BYTES: usize = 10 * 1024 * 1024 + 1;

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    if request.method() == Method::POST {
        let _upload = state
            .uploads
            .acquire()
            .await
            .map_err(|_| HttpError::Internal)?;
        let upload = parse_upload(request).await?;
        let file = state.application.upload_message_file(upload).await?;
        return json(
            StatusCode::CREATED,
            ApiEnvelope {
                protocol_version: APP_PROTOCOL_VERSION,
                data: json!({"file": file}),
            },
        );
    }
    let encoded = request
        .uri()
        .path()
        .strip_prefix("/message-files/")
        .filter(|value| !value.is_empty() && !value.contains('/'))
        .ok_or_else(not_found)?;
    let id = decode_file_id(encoded)?;
    let download = state.application.download_message_file(id).await?;
    let size = download.bytes.len();
    let mut response = Response::new(Body::from(download.bytes));
    for (name, value) in [
        (header::CONTENT_TYPE, download.file.mime_type),
        (header::CONTENT_LENGTH, size.to_string()),
        (
            header::CONTENT_DISPOSITION,
            disposition(&download.file.safe_name),
        ),
        (header::CACHE_CONTROL, "no-store".to_owned()),
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
    ] {
        response
            .headers_mut()
            .insert(name, value.parse().map_err(|_| HttpError::Internal)?);
    }
    Ok(response)
}

async fn parse_upload(request: Request<Body>) -> Result<AppFileUpload, HttpError> {
    // Request.formData also accepts URL-encoded forms, which cannot contain a File.
    if request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/x-www-form-urlencoded")
        })
    {
        read_body_with_limit(request.into_body(), MAX_REQUEST_BODY_SIZE).await?;
        return Err(file_required());
    }
    let mut form = Multipart::from_request(request, &())
        .await
        .map_err(|_| invalid_multipart())?;
    let mut file_seen = false;
    let mut session_seen = false;
    let mut file = None;
    let mut owner_session_id = None;
    while let Some(mut field) = form.next_field().await.map_err(multipart_error)? {
        if field.name() == Some("file") && !file_seen {
            file_seen = true;
            let name = field.file_name().map(str::to_owned);
            let mime_type = field.content_type().map(str::to_owned).or_else(|| {
                name.as_deref()
                    .and_then(mime::inferred_content_type)
                    .map(str::to_owned)
            });
            let mut bytes = BytesMut::new();
            while let Some(chunk) = field.chunk().await.map_err(multipart_error)? {
                if name.is_some() {
                    let keep = chunk.len().min(UPLOAD_RETAIN_BYTES - bytes.len());
                    bytes.extend_from_slice(&chunk[..keep]);
                }
            }
            if let Some(name) = name {
                file = Some((name, mime_type, bytes.freeze()));
            }
        } else if field.name() == Some("session_id") && !session_seen {
            session_seen = true;
            if field.file_name().is_none() {
                let value = field.text().await.map_err(multipart_error)?;
                let value = trim_js_whitespace(&value);
                if !value.is_empty() {
                    owner_session_id = Some(value.to_owned());
                }
            } else {
                while field.chunk().await.map_err(multipart_error)?.is_some() {}
            }
        } else {
            while field.chunk().await.map_err(multipart_error)?.is_some() {}
        }
    }
    let (name, mime_type, bytes) = file.ok_or_else(file_required)?;
    Ok(AppFileUpload {
        owner_session_id,
        name,
        mime_type,
        bytes,
    })
}

fn disposition(name: &str) -> String {
    let source = if name.is_empty() { "attachment" } else { name };
    let mut fallback = String::new();
    for character in source.chars() {
        let character = if (' '..='~').contains(&character) && !matches!(character, '"' | '\\') {
            character
        } else {
            '_'
        };
        if character != '_' || !fallback.ends_with('_') {
            fallback.push(character);
        }
    }
    let fallback: String = fallback.trim().chars().take(160).collect();
    let fallback = if fallback.bytes().any(|byte| byte.is_ascii_alphanumeric()) {
        fallback.as_str()
    } else {
        "attachment"
    };
    let mut encoded = String::new();
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~".contains(&byte) {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(&mut encoded, "%{byte:02X}").expect("writing a String cannot fail");
        }
    }
    format!("inline; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

fn decode_file_id(encoded: &str) -> Result<String, HttpError> {
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut input = encoded.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = char::from(input.next().ok_or(HttpError::Internal)?)
                .to_digit(16)
                .ok_or(HttpError::Internal)?;
            let low = char::from(input.next().ok_or(HttpError::Internal)?)
                .to_digit(16)
                .ok_or(HttpError::Internal)?;
            decoded.push((high * 16 + low) as u8);
        } else {
            decoded.push(byte);
        }
    }
    let value = String::from_utf8(decoded).map_err(|_| HttpError::Internal)?;
    if value.len() != 41
        || value
            .get(..5)
            .is_none_or(|prefix| !prefix.eq_ignore_ascii_case("file-"))
        || !value[5..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err(not_found());
    }
    Ok(value)
}

fn multipart_error(error: MultipartError) -> HttpError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        HttpError::PayloadTooLarge
    } else {
        invalid_multipart()
    }
}
fn invalid_multipart() -> HttpError {
    HttpError::public(
        400,
        "invalid_multipart",
        "File upload must be multipart form data.",
    )
}
fn file_required() -> HttpError {
    HttpError::public(400, "file_required", "A file field is required.")
}
fn not_found() -> HttpError {
    HttpError::public(404, "message_file_not_found", "Message file was not found.")
}
