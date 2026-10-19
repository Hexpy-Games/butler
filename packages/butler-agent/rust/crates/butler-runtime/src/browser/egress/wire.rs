//! HTTP/1 proxy framing. Opaque tunnels never enter the response parser.
use butler_log::http::ConnectionStream;
use std::{io, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
const MAX_HEAD: usize = 64 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) struct Head {
    pub(super) method: String,
    pub(super) target: String,
    pub(super) version: String,
    pub(super) headers: Vec<(String, String)>,
    pub(super) rest: Vec<u8>,
}

pub(super) async fn read_head<R: AsyncRead + Unpin>(stream: &mut R) -> Option<Head> {
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0_u8; 4096];
    let end = loop {
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        if buffer.len() > MAX_HEAD {
            return None;
        }
        let read = tokio::time::timeout(HEAD_TIMEOUT, stream.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let text = std::str::from_utf8(&buffer[..end]).ok()?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.splitn(3, ' ');
    let (method, target) = (first.next()?, first.next()?);
    let version = first.next().unwrap_or("");
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_owned(), value.trim().to_owned()))
        .collect();
    Some(Head {
        method: method.into(),
        target: target.into(),
        version: version.into(),
        headers,
        rest: buffer[end + 4..].to_vec(),
    })
}

/// Hop-by-hop and proxy headers never reach the other side.
fn end_to_end(name: &str) -> bool {
    !matches!(
        name.to_ascii_lowercase().as_str(),
        "connection" | "keep-alive" | "proxy-connection" | "proxy-authorization" | "te" | "upgrade"
    )
}

pub(super) fn rewrite(first_line: &str, headers: &[(String, String)]) -> Vec<u8> {
    let mut out = format!("{first_line}\r\n");
    for (name, value) in headers.iter().filter(|(name, _)| end_to_end(name)) {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("Connection: close\r\n\r\n");
    out.into_bytes()
}

/// Upload is borrowed alongside download, so cancellation stops both directions.
pub(super) async fn relay(
    client: TcpStream,
    upstream: ConnectionStream,
    request: Vec<u8>,
    body: Vec<u8>,
) -> io::Result<()> {
    let (mut client_read, mut client_write) = client.into_split();
    let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);
    let up = async {
        upstream_write.write_all(&request).await?;
        upstream_write.write_all(&body).await?;
        tokio::io::copy(&mut client_read, &mut upstream_write).await?;
        Ok::<_, io::Error>(())
    };
    let down = async {
        let head = read_head(&mut upstream_read)
            .await
            .ok_or(io::ErrorKind::InvalidData)?;
        let first = format!("{} {} {}", head.method, head.target, head.version)
            .trim_end()
            .to_owned();
        client_write
            .write_all(&rewrite(&first, &head.headers))
            .await?;
        client_write.write_all(&head.rest).await?;
        tokio::io::copy(&mut upstream_read, &mut client_write).await?;
        client_write.shutdown().await
    };
    tokio::pin!(down);
    tokio::select! {
        result = up => { result?; down.await },
        result = &mut down => result,
    }
}
