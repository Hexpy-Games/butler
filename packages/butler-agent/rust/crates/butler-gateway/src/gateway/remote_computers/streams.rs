//! Stream a response from the computer's local socket over a pinned SSH connection.
use super::{
    Computer, HostInput, HttpError, deploy, relay::unavailable, remote_error, ssh,
    store::KnownHosts,
};
use axum::body::{Body, Bytes};
use butler_platform::hook_process::StreamingProcess;
use serde::Deserialize;
use std::{collections::BTreeMap, io, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio_util::sync::CancellationToken;

pub(in crate::gateway) struct RemoteStream {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub(super) body: BufReader<StreamingProcess>,
    _known_hosts: KnownHosts,
}

pub(super) enum Opened {
    Stream(Box<RemoteStream>),
    NotRunning,
}

#[derive(Deserialize)]
struct Head {
    status: u16,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

pub(super) async fn open(
    computer: &Computer,
    path: &str,
    cancel: CancellationToken,
) -> Result<Opened, HttpError> {
    let known_hosts = KnownHosts::write(computer.host_keys.iter().cloned().collect()).await?;
    let target = HostInput {
        address: computer.address.clone(),
        port: computer.port.map(i64::from),
        key_file: computer.key_file.clone(),
    };
    let home = butler_platform::user_dirs::non_empty_home_dir();
    let command = format!(
        r#""$HOME/.butler-remote/current/butler-agent" --remote-stream "$HOME/.butler-remote/data" '{}'"#,
        path.replace('\'', "'\\''")
    );
    let args = ssh::arguments(
        &target,
        &known_hosts.0,
        "yes",
        &[],
        &command,
        home.as_deref(),
    )?;
    let mut body = BufReader::with_capacity(65_536, ssh::spawn(args).await?);
    let mut line = Vec::new();
    let mut limited = (&mut body).take(65_536);
    tokio::select! {
        result = tokio::time::timeout(Duration::from_mins(3), limited.read_until(b'\n', &mut line)) => {
            result.map_err(|_| unavailable())?.map_err(|_| unavailable())?;
        }
        () = cancel.cancelled() => return Err(unavailable()),
    }
    if line.is_empty() {
        let output = body
            .into_inner()
            .finish()
            .await
            .map_err(|_| unavailable())?;
        if output.stderr.contains("code=remote_response_invalid") {
            return Err(remote_error(
                "remote_response_invalid",
                "This computer's reply could not be read.",
            ));
        }
        if output.exit_code == Some(255) {
            deploy::check_exit(&output)?;
        }
        if output.exit_code == Some(127) || output.stderr.contains("code=remote_not_running") {
            return Ok(Opened::NotRunning);
        }
        return Err(unavailable());
    }
    let line = line.strip_suffix(b"\n").ok_or_else(unavailable)?;
    let Head { status, headers } = serde_json::from_slice(line).map_err(|_| unavailable())?;
    Ok(Opened::Stream(Box::new(RemoteStream {
        status,
        headers,
        body,
        _known_hosts: known_hosts,
    })))
}

impl RemoteStream {
    pub(in crate::gateway) fn into_body(self) -> Body {
        Body::from_stream(futures_util::stream::try_unfold(
            self.body,
            |mut body| async move {
                let mut bytes = vec![0; 65_536];
                let count = body.read(&mut bytes).await?;
                if count == 0 {
                    let failed = || io::Error::other("remote_stream_failed");
                    let output = body.into_inner().finish().await.map_err(|_| failed())?;
                    return if output.exit_code == Some(0) {
                        Ok(None)
                    } else {
                        Err(failed())
                    };
                }
                bytes.truncate(count);
                Ok(Some((Bytes::from(bytes), body)))
            },
        ))
    }
}
