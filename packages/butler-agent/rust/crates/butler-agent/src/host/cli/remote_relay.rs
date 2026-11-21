//! Internal SSH command forwarding stdin to the remote service's owner-only socket.
use crate::host::service::configuration::local_credentials::{
    CredentialFiles, LocalCredentials, data_folder_token,
};
use butler_platform::local_socket;
use serde_json::{Value, json};
use std::{ffi::OsString, io::Read, path::PathBuf, process::ExitCode, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) async fn request(args: &[OsString]) -> ExitCode {
    let (root, method, path) = match args {
        [data, method, path]
            if matches!(method.to_str(), Some("GET" | "POST" | "PATCH" | "DELETE"))
                && path.to_str().is_some_and(|p| {
                    p.starts_with('/') && !p.chars().any(|c| c.is_whitespace() || c.is_control())
                }) =>
        {
            (
                PathBuf::from(data),
                method.to_string_lossy(),
                path.to_string_lossy(),
            )
        }
        _ => {
            eprintln!("usage: butler-agent --remote-request <data> <METHOD> <PATH>");
            return ExitCode::from(2);
        }
    };
    let reply = async {
        let socket = root.join("remote/agent.sock");
        let (body, token, admin) = tokio::task::spawn_blocking(move || {
            const LIMIT: usize = 1024 * 1024;
            let mut body = Vec::new();
            std::io::stdin().lock().take(LIMIT as u64 + 1).read_to_end(&mut body)
                .map_err(|_| "remote_request_failed")?;
            if body.len() > LIMIT {
                return Err("remote_request_failed");
            }
            let token = data_folder_token(&root).ok_or("local_credential_unusable")?;
            let admin = LocalCredentials::load(&root, CredentialFiles::ReadOnly).admin.map_err(|_| "local_credential_unusable")?;
            Ok((body, token, admin))
        }).await.map_err(|_| "remote_request_failed")??;
        let mut stream = local_socket::connect(&socket).await.map_err(|_| "remote_not_running")?;
        let headers = format!(
            "{method} http://agent{path} HTTP/1.1\r\nHost: agent\r\nAuthorization: Bearer {token}\r\nX-Butler-Admin: {admin}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(headers.as_bytes()).await.map_err(|_| "remote_request_failed")?;
        stream.write_all(&body).await.map_err(|_| "remote_request_failed")?;
        const LIMIT: usize = 4 * 1024 * 1024;
        let invalid = "remote_response_invalid";
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(120), stream.take(LIMIT as u64 + 1).read_to_end(&mut response))
            .await.map_err(|_| invalid)?.map_err(|_| invalid)?;
        if response.len() > LIMIT {
            return Err(invalid);
        }
        let (headers, body) = std::str::from_utf8(&response).map_err(|_| invalid)?.split_once("\r\n\r\n").ok_or(invalid)?;
        let mut lines = headers.lines();
        let status: u16 = lines.next().and_then(|line| line.split_whitespace().nth(1))
            .and_then(|status| status.parse().ok()).ok_or(invalid)?;
        if lines.any(|line| {
            let lower = line.to_ascii_lowercase();
            lower.starts_with("transfer-encoding:") && lower.contains("chunked")
        }) {
            return Err(invalid);
        }
        let body = if body.is_empty() { Value::Null } else { serde_json::from_str(body).map_err(|_| invalid)? };
        Ok(json!({"status": status, "body": body}))
    }.await;
    match reply {
        Ok(value) => {
            println!("{value}");
            ExitCode::SUCCESS
        }
        Err(code) => {
            eprintln!("remote_request_failed code={code}");
            ExitCode::FAILURE
        }
    }
}

pub(super) async fn loopback(args: &[OsString]) -> ExitCode {
    use std::io::Write;
    use tokio::{net::TcpStream, time::timeout};

    let reply = async {
        let [port] = args else { return Err("connect") };
        let port = port
            .to_str()
            .and_then(|p| p.parse::<u16>().ok())
            .ok_or("connect")?;
        #[allow(
            clippy::disallowed_methods,
            reason = "raw loopback relay for a sign-in callback that must stay out of HTTP logs"
        )]
        let mut stream = timeout(
            Duration::from_secs(10),
            TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        .map_err(|_| "connect")?
        .map_err(|_| "connect")?;
        let head = tokio::task::spawn_blocking(|| {
            let mut bytes = Vec::new();
            std::io::stdin()
                .lock()
                .take(64 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "io")?;
            if bytes.len() > 64 * 1024 {
                return Err("io");
            }
            Ok(bytes)
        })
        .await
        .map_err(|_| "io")??;
        stream.write_all(&head).await.map_err(|_| "io")?;
        stream.shutdown().await.map_err(|_| "io")?;
        let mut bytes = Vec::new();
        timeout(
            Duration::from_secs(60),
            stream.take(1024 * 1024 + 1).read_to_end(&mut bytes),
        )
        .await
        .map_err(|_| "io")?
        .map_err(|_| "io")?;
        if bytes.len() > 1024 * 1024 {
            return Err("io");
        }
        tokio::task::spawn_blocking(move || std::io::stdout().lock().write_all(&bytes))
            .await
            .map_err(|_| "io")?
            .map_err(|_| "io")
    }
    .await;
    match reply {
        Ok(()) => ExitCode::SUCCESS,
        Err(code) => {
            eprintln!("remote_loopback_failed code={code}");
            ExitCode::FAILURE
        }
    }
}
