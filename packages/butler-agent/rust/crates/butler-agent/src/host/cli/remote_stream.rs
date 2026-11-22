//! Stream a GET response from the remote service's owner-only socket to SSH stdout.
use crate::host::service::configuration::local_credentials::{
    CredentialFiles, LocalCredentials, data_folder_token,
};
use butler_platform::local_socket::{self, LocalStream};
use serde_json::{Value, json};
use std::{collections::BTreeMap, ffi::OsString, path::PathBuf, process::ExitCode, time::Duration};
use tokio::io::{self, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Stdout};

const BUFFER: usize = 65_536;
const INVALID: &str = "remote_response_invalid";
const TRUNCATED: &str = "remote_stream_truncated";

enum Framing {
    Chunked,
    Length(u64),
    Close,
}

pub(super) async fn stream(args: &[OsString]) -> ExitCode {
    let (root, path) = match args {
        [data, path]
            if path.to_str().is_some_and(|p| {
                p.starts_with('/') && !p.chars().any(|c| c.is_whitespace() || c.is_control())
            }) =>
        {
            (PathBuf::from(data), path.to_string_lossy())
        }
        _ => {
            eprintln!("usage: butler-agent --remote-stream <data> <PATH>");
            return ExitCode::from(2);
        }
    };
    let result = async {
        let socket = root.join("remote/agent.sock");
        let (token, admin) = tokio::task::spawn_blocking(move || {
            let token = data_folder_token(&root).ok_or("local_credential_unusable")?;
            let admin = LocalCredentials::load(&root, CredentialFiles::ReadOnly)
                .admin.map_err(|_| "local_credential_unusable")?;
            Ok::<_, &'static str>((token, admin))
        }).await.map_err(|_| "local_credential_unusable")??;
        let mut socket = local_socket::connect(&socket).await.map_err(|_| "remote_not_running")?;
        let request = format!("GET http://agent{path} HTTP/1.1\r\nHost: agent\r\nAuthorization: Bearer {token}\r\nX-Butler-Admin: {admin}\r\nConnection: close\r\n\r\n");
        socket.write_all(request.as_bytes()).await.map_err(|_| "remote_request_failed")?;
        let mut reader = BufReader::with_capacity(BUFFER, socket);
        let (head, framing) = tokio::time::timeout(Duration::from_secs(120), read_head(&mut reader))
            .await.map_err(|_| INVALID)??;
        let mut out = io::stdout();
        out.write_all(format!("{head}\n").as_bytes()).await.map_err(|_| "io")?;
        out.flush().await.map_err(|_| "io")?;
        write_body(&mut reader, &mut out, framing).await
    }.await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(code) => {
            eprintln!("remote_stream_failed code={code}");
            ExitCode::FAILURE
        }
    }
}

async fn read_head(reader: &mut BufReader<LocalStream>) -> Result<(Value, Framing), &'static str> {
    let mut head = Vec::new();
    let mut limited = reader.take(BUFFER as u64);
    loop {
        let n = limited
            .read_until(b'\n', &mut head)
            .await
            .map_err(|_| INVALID)?;
        if n == 0 {
            return Err(INVALID);
        }
        if n == 2 && head.ends_with(b"\r\n") {
            break;
        }
    }
    let mut lines = std::str::from_utf8(&head)
        .map_err(|_| INVALID)?
        .split("\r\n");
    let mut status_line = lines.next().ok_or(INVALID)?.split_whitespace();
    if !matches!(status_line.next(), Some("HTTP/1.0" | "HTTP/1.1")) {
        return Err(INVALID);
    }
    let status: u16 = status_line
        .next()
        .filter(|s| s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse().ok())
        .filter(|s| *s >= 100)
        .ok_or(INVALID)?;
    let mut headers = BTreeMap::new();
    let mut length = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "transfer-encoding" if value.eq_ignore_ascii_case("chunked") => chunked = true,
            "content-length" => length = Some(value),
            "content-type"
            | "content-disposition"
            | "content-security-policy"
            | "cache-control"
            | "x-content-type-options" => {
                headers.insert(name, value);
            }
            _ => {}
        }
    }
    let framing = if chunked {
        Framing::Chunked
    } else if let Some(length) = length {
        Framing::Length(length.parse().map_err(|_| INVALID)?)
    } else {
        Framing::Close
    };
    Ok((json!({"status":status,"headers":headers}), framing))
}

async fn write_body(
    reader: &mut BufReader<LocalStream>,
    out: &mut Stdout,
    framing: Framing,
) -> Result<(), &'static str> {
    match framing {
        Framing::Chunked => loop {
            let mut line = Vec::new();
            (&mut *reader)
                .take(1025)
                .read_until(b'\n', &mut line)
                .await
                .map_err(|_| "io")?;
            if line.len() > 1024 {
                return Err(INVALID);
            }
            if !line.ends_with(b"\n") {
                return Err(TRUNCATED);
            }
            let size = line.strip_suffix(b"\r\n").ok_or(INVALID)?;
            if !size.iter().all(u8::is_ascii_hexdigit) {
                return Err(INVALID);
            }
            let n = u64::from_str_radix(std::str::from_utf8(size).map_err(|_| INVALID)?, 16)
                .map_err(|_| INVALID)?;
            if n == 0 {
                return Ok(());
            }
            if io::copy(&mut (&mut *reader).take(n), out)
                .await
                .map_err(|_| "io")?
                != n
            {
                return Err(TRUNCATED);
            }
            let mut crlf = [0; 2];
            reader.read_exact(&mut crlf).await.map_err(|_| TRUNCATED)?;
            if crlf != *b"\r\n" {
                return Err(TRUNCATED);
            }
            out.flush().await.map_err(|_| "io")?;
        },
        Framing::Length(n) => {
            if io::copy(&mut reader.take(n), out).await.map_err(|_| "io")? != n {
                return Err(TRUNCATED);
            }
            out.flush().await.map_err(|_| "io")
        }
        Framing::Close => {
            let mut buffer = vec![0; BUFFER];
            loop {
                let n = reader.read(&mut buffer).await.map_err(|_| "io")?;
                if n == 0 {
                    return Ok(());
                }
                out.write_all(&buffer[..n]).await.map_err(|_| "io")?;
                out.flush().await.map_err(|_| "io")?;
            }
        }
    }
}
