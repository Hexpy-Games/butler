//! The space's push socket, over a logged `butler_log::http::Connection`.
use std::{io, time::Duration};

use butler_log::http::{Connection, ConnectionStream, Purpose};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream,
    tungstenite::{
        self,
        client::IntoClientRequest,
        http::{HeaderValue, header::AUTHORIZATION},
    },
};

pub(super) struct Socket {
    pub(super) stream: WebSocketStream<MaybeTlsStream<ConnectionStream>>,
    connection: Connection,
}
pub(super) enum ConnectError {
    /// The handshake got this HTTP status instead of an upgrade.
    Status(u16),
    Failed,
}
impl Socket {
    /// Closes the connection record once the socket has ended.
    pub(super) fn finish(self, result: io::Result<()>) {
        self.connection.finish(result);
    }
}

/// `{base}/v1/canon{space_path}/socket`, with `http`→`ws` and `https`→`wss`.
pub(super) async fn connect(
    base: &str,
    space_path: &str,
    token: &str,
) -> Result<Socket, ConnectError> {
    let mut url = url::Url::parse(&format!("{base}/v1/canon{space_path}/socket"))
        .map_err(|_| ConnectError::Failed)?;
    let scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        _ => return Err(ConnectError::Failed),
    };
    url.set_scheme(scheme).map_err(|()| ConnectError::Failed)?;
    let host = url.host_str().ok_or(ConnectError::Failed)?.to_owned();
    let port = url.port_or_known_default().ok_or(ConnectError::Failed)?;
    let addresses: Vec<_> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| ConnectError::Failed)?
        .collect();
    let connection = Connection::new(&host, port, &Purpose::new("butler-cloud"));
    let stream = match connection.connect(&addresses, Duration::from_secs(5)).await {
        Ok(stream) => stream,
        Err(error) => {
            connection.finish(Err(error));
            return Err(ConnectError::Failed);
        }
    };
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| ConnectError::Failed)?;
    let bearer =
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(|_| ConnectError::Failed)?;
    request.headers_mut().insert(AUTHORIZATION, bearer);
    match tokio_tungstenite::client_async_tls_with_config(request, stream, None, None).await {
        Ok((stream, _)) => Ok(Socket { stream, connection }),
        Err(tungstenite::Error::Http(response)) => {
            connection.finish(Err(io::Error::other("websocket handshake refused")));
            Err(ConnectError::Status(response.status().as_u16()))
        }
        Err(error) => {
            connection.finish(Err(io::Error::other(error)));
            Err(ConnectError::Failed)
        }
    }
}
