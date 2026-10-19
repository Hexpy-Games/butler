//! Named process barriers, compiled only for test-support builds.
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub async fn reach(point: &str, turn_id: &str) {
    let Ok(address) = std::env::var("BUTLER_TEST_PAUSE_ADDR") else {
        return;
    };
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    stream
        .write_all(format!("{point}\t{turn_id}\n").as_bytes())
        .await
        .unwrap();
    let mut release = [0];
    stream.read_exact(&mut release).await.unwrap();
}
