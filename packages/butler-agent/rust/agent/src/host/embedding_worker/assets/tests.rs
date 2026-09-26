
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

#[tokio::test]
async fn interrupted_partial_is_not_visible_and_resumes_with_verified_range() {
    const CONTENT: &[u8] = b"tiny-asset-complete";
    let data_root =
        std::env::temp_dir().join(format!("butler-embedding-asset-{}", uuid::Uuid::new_v4()));
    let root = data_root.join("model");
    let staging = root.join(STAGING);
    fs::create_dir_all(&staging).expect("staging");
    let asset = Asset {
        relative: "tiny.bin",
        bytes: CONTENT.len() as u64,
        sha256: "40e45bd34cf27082ab557df0b1de054795f559a433f93fae2dd76dae9d1d4cb3",
    };
    fs::write(part_path(&staging, &asset), &CONTENT[..5]).expect("interrupted bytes");
    assert!(
        !root.join(asset.relative).exists(),
        "partial is not a final asset"
    );

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("local fixture");
    let address = listener.local_addr().expect("listener address");
    let saw_range = Arc::new(AtomicBool::new(false));
    let saw_range_server = saw_range.clone();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("fixture request");
        let mut request = Vec::new();
        let mut chunk = [0_u8; 1024];
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let count = socket.read(&mut chunk).await.expect("read fixture request");
            assert!(count > 0 && request.len() + count <= 4096);
            request.extend_from_slice(&chunk[..count]);
        }
        let text = String::from_utf8_lossy(&request).to_ascii_lowercase();
        saw_range_server.store(text.contains("range: bytes=5-"), Ordering::Release);
        socket
                .write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 5-18/19\r\nContent-Length: 14\r\nConnection: close\r\n\r\n")
                .await
                .expect("fixture header");
        socket.write_all(&CONTENT[5..]).await.expect("fixture body");
    });
    let client = Client::new();
    tokio::time::timeout(
        std::time::Duration::from_secs(3),
        acquire(&data_root, &root, &[asset], &client, |_| {
            format!("http://{address}/tiny")
        }),
    )
    .await
    .expect("bounded acquisition")
    .expect("resumed acquisition");
    server.await.expect("fixture served");
    assert!(saw_range.load(Ordering::Acquire));
    assert_eq!(
        fs::read(root.join("tiny.bin")).expect("final asset"),
        CONTENT
    );
    assert!(!staging.join("tiny.bin.part").exists());
    fs::remove_dir_all(data_root).expect("remove isolated fixture");
}
