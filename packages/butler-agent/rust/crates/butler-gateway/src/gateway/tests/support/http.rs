use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};

use super::*;

/// Sends a raw request; `host: localhost` names the listener's port, as the
/// gateway answers loopback names only with their bound port.
pub(in crate::gateway::tests) async fn request(
    address: std::net::SocketAddr,
    request: &str,
) -> String {
    let request = request.replacen(
        "host: localhost\r\n",
        &format!("host: localhost:{}\r\n", address.port()),
        1,
    );
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    String::from_utf8(response).unwrap()
}

pub(in crate::gateway::tests) async fn authorized_json(
    address: std::net::SocketAddr,
    body: &str,
) -> String {
    request(
        address,
        &format!(
            "POST /messages HTTP/1.1\r\nhost: localhost\r\nauthorization: Bearer secret\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        ),
    )
    .await
}
