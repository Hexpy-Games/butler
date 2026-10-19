//! rmcp backend using Butler's HTTP boundary, preserving protocol handling.
mod sse;
use butler_log::http::{Client, RequestBuilder};
use futures_util::stream::BoxStream;
use reqwest::{
    Response, StatusCode,
    header::{HeaderName, HeaderValue},
};
use rmcp::{
    model::{ClientJsonRpcMessage, ClientRequest, ErrorData, JsonRpcMessage, ServerJsonRpcMessage},
    transport::streamable_http_client::{
        AuthRequiredError, InsufficientScopeError, SseError, StreamableHttpClient,
        StreamableHttpError, StreamableHttpPostResponse,
    },
};
use sse_stream::Sse;
use std::{collections::HashMap, sync::Arc};
type Error = StreamableHttpError<butler_log::http::Error>;
const DEFAULT_LIMIT: usize = 16 * 1024 * 1024;
#[derive(Clone)]
pub(super) struct LoggedHttp(pub Client, tracing::Span);
use tracing::Instrument;
pub(super) fn client() -> Result<Client, reqwest::Error> {
    butler_log::http::external(butler_log::http::Purpose::new("mcp"))
        .pool_max_idle_per_host(0)
        .redirect(butler_log::http::RedirectPolicy::none())
        .build()
}
pub(super) fn transport(
    config: rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig,
) -> Result<rmcp::transport::StreamableHttpClientTransport<LoggedHttp>, reqwest::Error> {
    Ok(rmcp::transport::StreamableHttpClientTransport::with_client(
        LoggedHttp(client()?, tracing::Span::current()),
        config,
    ))
}
impl StreamableHttpClient for LoggedHttp {
    type Error = butler_log::http::Error;
    async fn get_stream(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last: Option<String>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, Error> {
        self.get_stream_with_max_sse_event_size(uri, session, last, auth, custom, DEFAULT_LIMIT)
            .await
    }
    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session: Option<Arc<str>>,
        last: Option<String>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
        limit: usize,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, Error> {
        let mut request = headers(self.0.get(uri.as_ref()), session, auth, custom)?;
        if let Some(last) = last {
            request = request.header("last-event-id", last);
        }
        let response = request
            .send()
            .instrument(self.1.clone())
            .await
            .map_err(StreamableHttpError::Client)?;
        if response.status() == StatusCode::METHOD_NOT_ALLOWED {
            return Err(StreamableHttpError::ServerDoesNotSupportSse);
        }
        authenticate(&response)?;
        let response = response
            .error_for_status()
            .map_err(|e| StreamableHttpError::Client(e.into()))?;
        let mime = mime(&response);
        if !mime.as_deref().is_some_and(|v| {
            v.starts_with("text/event-stream") || v.starts_with("application/json")
        }) {
            return Err(StreamableHttpError::UnexpectedContentType(mime));
        }
        Ok(sse::bounded(response, limit))
    }
    async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), Error> {
        let response = headers(self.0.delete(uri.as_ref()), Some(session), auth, custom)?
            .send()
            .instrument(self.1.clone())
            .await
            .map_err(StreamableHttpError::Client)?;
        if response.status() != StatusCode::METHOD_NOT_ALLOWED {
            response
                .error_for_status()
                .map_err(|e| StreamableHttpError::Client(e.into()))?;
        }
        Ok(())
    }
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, Error> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session,
            auth,
            custom,
            DEFAULT_LIMIT,
        )
        .await
    }
    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session: Option<Arc<str>>,
        auth: Option<String>,
        custom: HashMap<HeaderName, HeaderValue>,
        limit: usize,
    ) -> Result<StreamableHttpPostResponse, Error> {
        let attached = session.is_some();
        let response = headers(self.0.post(uri.as_ref()), session, auth, custom)?
            .json(&message)
            .send()
            .instrument(self.1.clone())
            .await
            .map_err(StreamableHttpError::Client)?;
        authenticate(&response)?;
        post_response(response, &message, attached, limit).await
    }
}
fn headers(
    mut request: RequestBuilder,
    session: Option<Arc<str>>,
    auth: Option<String>,
    custom: HashMap<HeaderName, HeaderValue>,
) -> Result<RequestBuilder, Error> {
    request = request.header("accept", "text/event-stream, application/json");
    if let Some(session) = session {
        request = request.header("mcp-session-id", session.as_ref());
    }
    if let Some(auth) = auth {
        request = request.bearer_auth(auth);
    }
    for (name, value) in custom {
        if matches!(name.as_str(), "accept" | "mcp-session-id" | "last-event-id") {
            return Err(StreamableHttpError::ReservedHeaderConflict(
                name.to_string(),
            ));
        }
        request = request.header(name, value);
    }
    Ok(request)
}
fn mime(response: &Response) -> Option<String> {
    response
        .headers()
        .get("content-type")
        .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
}
fn authenticate(response: &Response) -> Result<(), Error> {
    let Some(header) = response.headers().get("www-authenticate") else {
        return Ok(());
    };
    if !matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        return Ok(());
    }
    let header = header
        .to_str()
        .map_err(|_| {
            StreamableHttpError::UnexpectedServerResponse(
                "invalid www-authenticate header value".into(),
            )
        })?
        .to_owned();
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err(StreamableHttpError::AuthRequired(AuthRequiredError::new(
            header,
        )));
    }
    let required_scope = scope(&header);
    Err(StreamableHttpError::InsufficientScope(
        InsufficientScopeError::new(header, required_scope),
    ))
}
fn scope(header: &str) -> Option<String> {
    let lower = header.to_ascii_lowercase();
    let start = lower.find("scope=")? + 6;
    let value = &header[start..];
    if let Some(value) = value.strip_prefix('"') {
        return value.find('"').map(|n| value[..n].to_owned());
    }
    let value = value
        .split([',', ';', ' ', '\t'])
        .next()
        .unwrap_or_default();
    (!value.is_empty()).then(|| value.to_owned())
}
async fn post_response(
    response: Response,
    message: &ClientJsonRpcMessage,
    attached: bool,
    limit: usize,
) -> Result<StreamableHttpPostResponse, Error> {
    let status = response.status();
    if matches!(status, StatusCode::ACCEPTED | StatusCode::NO_CONTENT) {
        return Ok(StreamableHttpPostResponse::Accepted);
    }
    if status == StatusCode::NOT_FOUND && attached {
        return Err(StreamableHttpError::SessionExpired);
    }
    let mime = mime(&response);
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let notification = !matches!(message, ClientJsonRpcMessage::Request(_));
    if status.is_success() && response.content_length() == Some(0) && notification {
        return Ok(StreamableHttpPostResponse::Accepted);
    }
    if !status.is_success() {
        return rejected(response, message, attached, mime, session).await;
    }
    match mime.as_deref() {
        Some(v) if v.starts_with("text/event-stream") => Ok(StreamableHttpPostResponse::Sse(
            sse::bounded(response, limit),
            session,
        )),
        Some(v) if v.starts_with("application/json") => {
            let bytes = response
                .bytes()
                .await
                .map_err(|e| StreamableHttpError::Client(e.into()))?;
            match serde_json::from_slice(&bytes) {
                Ok(value) => Ok(StreamableHttpPostResponse::Json(value, session)),
                Err(_) if notification => Ok(StreamableHttpPostResponse::Accepted),
                Err(error) => Err(invalid_json(&error, &bytes)),
            }
        }
        _ => Err(StreamableHttpError::UnexpectedContentType(mime)),
    }
}
async fn rejected(
    response: Response,
    message: &ClientJsonRpcMessage,
    attached: bool,
    mime: Option<String>,
    session: Option<String>,
) -> Result<StreamableHttpPostResponse, Error> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if mime
        .as_deref()
        .is_some_and(|v| v.starts_with("application/json"))
        && let Ok(value @ JsonRpcMessage::Error(_)) =
            serde_json::from_str::<ServerJsonRpcMessage>(&body)
    {
        return Ok(StreamableHttpPostResponse::Json(value, session));
    }
    if !attached
        && status.is_client_error()
        && !matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        && let ClientJsonRpcMessage::Request(request) = message
        && matches!(request.request, ClientRequest::DiscoverRequest(_))
    {
        let error = ErrorData::invalid_request(
            format!("server/discover rejected with HTTP {status}: {body}"),
            None,
        );
        return Ok(StreamableHttpPostResponse::Json(
            ServerJsonRpcMessage::error(error, Some(request.id.clone())),
            None,
        ));
    }
    Err(StreamableHttpError::UnexpectedServerResponse(
        format!("HTTP {status}: {body}").into(),
    ))
}

fn invalid_json(error: &serde_json::Error, bytes: &[u8]) -> Error {
    let text = if bytes.is_empty() {
        std::borrow::Cow::Borrowed("<empty>")
    } else {
        String::from_utf8_lossy(bytes)
    };
    let mut end = text.len().min(256);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    StreamableHttpError::UnexpectedServerResponse(
        format!(
            "could not parse JSON response as ServerJsonRpcMessage: {error}: {}",
            &text[..end]
        )
        .into(),
    )
}
