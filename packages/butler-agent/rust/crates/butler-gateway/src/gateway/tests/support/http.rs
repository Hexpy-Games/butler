use super::*;

pub(in crate::gateway::tests) async fn authorized_json(
    address: std::net::SocketAddr,
    body: &str,
) -> String {
    request(
        address,
        &format!(
            "POST /messages HTTP/1.1\r\nhost: localhost\r\nauthorization: Bearer secret\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        ),
    )
    .await
}
