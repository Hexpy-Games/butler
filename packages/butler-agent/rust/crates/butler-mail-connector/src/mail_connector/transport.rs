use super::{Result, config::Endpoint};
use std::{fmt::Debug, sync::Arc};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};
use tokio_rustls::TlsConnector;

pub(super) trait Stream: AsyncRead + AsyncWrite + Unpin + Send + Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Debug> Stream for T {}
pub(super) type Socket = Box<dyn Stream>;

#[allow(
    clippy::disallowed_methods,
    reason = "IMAP protocol transport, not an HTTP request"
)]
pub(super) async fn connect(endpoint: &Endpoint) -> Result<Socket> {
    let stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port))
        .await
        .map_err(|_| "mail_connect_failed")?;
    butler_platform::network::tcp_keepalive(&stream).map_err(|_| "mail_keepalive_failed")?;
    if endpoint.security == "tls" {
        tls(Box::new(stream), &endpoint.host).await
    } else {
        Ok(Box::new(stream))
    }
}
pub(super) async fn tls(stream: Socket, host: &str) -> Result<Socket> {
    let config = tokio::task::spawn_blocking(|| {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_native_certs::load_native_certs().certs {
            roots.add(cert).map_err(|_| "mail_tls_roots_failed")?;
        }
        let provider = rustls::crypto::ring::default_provider();
        rustls::ClientConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .map_err(|_| "mail_tls_failed")
            .map(|b| b.with_root_certificates(roots).with_no_client_auth())
    })
    .await
    .map_err(|_| "mail_tls_failed")??;
    let name = rustls::pki_types::ServerName::try_from(host.to_owned())
        .map_err(|_| "mail_tls_hostname_invalid")?;
    let socket = TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await
        .map_err(|_| "mail_tls_failed")?;
    Ok(Box::new(socket))
}
