//! The desktop loopback and remote Unix transports for control frames.

use super::{ControlContext, IO_TIMEOUT, MAX_FRAME_BYTES, accept};
use crate::host::HostError;
use butler_platform::local_socket::{self, LocalListener};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

pub(super) enum Listener {
    Tcp(TcpListener),
    Local(LocalListener),
}

impl Listener {
    pub(super) async fn bind(socket: Option<&Path>) -> Result<(Self, String), HostError> {
        let failed = |source| HostError::new("gateway_control_bind_failed").with_source(source);
        if let Some(path) = socket {
            let path = path.to_path_buf();
            let endpoint = format!("unix:{}", path.display());
            let listener = tokio::task::spawn_blocking(move || local_socket::bind(&path))
                .await
                .map_err(HostError::from_error)?
                .map_err(HostError::from_error)?;
            return Ok((Self::Local(listener), endpoint));
        }
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(failed)?;
        let endpoint = listener.local_addr().map_err(failed)?.to_string();
        Ok((Self::Tcp(listener), endpoint))
    }

    pub(super) async fn serve(self, context: Arc<ControlContext>, shutdown: CancellationToken) {
        match self {
            Self::Tcp(listener) => {
                accept::run(
                    || async { listener.accept().await.map(|(stream, _)| stream) },
                    context,
                    shutdown,
                )
                .await;
            }
            Self::Local(listener) => {
                accept::run(|| local_socket::accept(&listener), context, shutdown).await;
            }
        }
    }
}

pub(super) enum Target {
    Tcp(SocketAddr),
    Local(PathBuf),
}

impl Target {
    pub(super) fn parse(endpoint: &str, data_root: &Path) -> Result<Self, HostError> {
        let invalid = "gateway_control_identity_invalid";
        if let Some(path) = endpoint.strip_prefix("unix:") {
            let expected = data_root.join("remote/control.sock");
            if path != expected.to_string_lossy() {
                return Err(invalid.into());
            }
            return Ok(Self::Local(expected));
        }
        let address: SocketAddr = endpoint
            .parse()
            .map_err(|source| HostError::new(invalid).with_source(source))?;
        if !address.ip().is_loopback() {
            return Err(invalid.into());
        }
        Ok(Self::Tcp(address))
    }

    #[allow(
        clippy::disallowed_methods,
        reason = "authenticated loopback framed control protocol; not HTTP"
    )]
    pub(super) async fn connect(self) -> Result<Box<dyn ControlStream>, HostError> {
        timeout(IO_TIMEOUT, async {
            match self {
                Self::Tcp(address) => TcpStream::connect(address)
                    .await
                    .map(|stream| Box::new(stream) as Box<dyn ControlStream>),
                Self::Local(path) => local_socket::connect(&path)
                    .await
                    .map(|stream| Box::new(stream) as Box<dyn ControlStream>),
            }
        })
        .await
        .map_err(|source| HostError::new("gateway_control_timeout").with_source(source))?
        .map_err(|source| HostError::new("gateway_control_unavailable").with_source(source))
    }
}

pub(super) trait ControlStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ControlStream for T {}

pub(super) async fn read_frame<T: for<'de> Deserialize<'de>>(
    stream: &mut (impl AsyncRead + Unpin),
) -> Result<T, crate::host::HostError> {
    let length = stream.read_u32().await.map_err(|source| {
        crate::host::HostError::new("gateway_control_request_invalid").with_source(source)
    })? as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err("gateway_control_request_invalid".into());
    }
    let mut bytes = vec![0; length];
    stream.read_exact(&mut bytes).await.map_err(|source| {
        crate::host::HostError::new("gateway_control_request_invalid").with_source(source)
    })?;
    serde_json::from_slice(&bytes).map_err(|source| {
        crate::host::HostError::new("gateway_control_request_invalid").with_source(source)
    })
}

pub(super) async fn write_frame<T: Serialize>(
    stream: &mut (impl AsyncWrite + Unpin),
    value: &T,
) -> Result<(), crate::host::HostError> {
    let bytes = serde_json::to_vec(value).map_err(|source| {
        crate::host::HostError::new("gateway_control_response_invalid").with_source(source)
    })?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME_BYTES {
        return Err("gateway_control_response_invalid".into());
    }
    stream
        .write_u32(u32::try_from(bytes.len()).unwrap_or(u32::MAX))
        .await
        .map_err(|source| {
            crate::host::HostError::new("gateway_control_response_failed").with_source(source)
        })?;
    stream.write_all(&bytes).await.map_err(|source| {
        crate::host::HostError::new("gateway_control_response_failed").with_source(source)
    })?;
    stream.flush().await.map_err(|source| {
        crate::host::HostError::new("gateway_control_response_failed").with_source(source)
    })
}
