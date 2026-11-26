use super::{HarnessError, Launch, Value, harness_error, local_socket};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(crate) async fn socket(
    remote: &Launch,
    method: &str,
    route: &str,
    body: Option<&Value>,
) -> Result<(u16, Value), HarnessError> {
    let token = remote
        .data_folder_token()
        .ok_or_else(|| harness_error("no local token"))?;
    let admin = remote
        .admin_credential()
        .ok_or_else(|| harness_error("no admin credential"))?;
    let mut stream = local_socket::connect(&remote.data.join("remote/agent.sock")).await?;
    let body = body.map(ToString::to_string).unwrap_or_default();
    let request = format!(
        "{method} http://agent{route} HTTP/1.1\r\nHost: agent\r\nAuthorization: Bearer {token}\r\nX-Butler-Admin: {admin}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await?;
    let mut response = String::new();
    stream.read_to_string(&mut response).await?;
    let (headers, payload) = response
        .split_once("\r\n\r\n")
        .ok_or_else(|| harness_error("invalid socket response"))?;
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| harness_error("invalid status"))?;
    let body = if payload.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(payload)?
    };
    Ok((status, body))
}
