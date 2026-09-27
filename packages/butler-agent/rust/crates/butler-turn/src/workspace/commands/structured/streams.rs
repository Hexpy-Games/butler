use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::mpsc;

#[derive(Clone, Copy)]
pub(super) enum StreamKind {
    Stdout,
    Stderr(usize),
}
pub(super) struct StreamChunk {
    pub(super) kind: StreamKind,
    pub(super) bytes: Vec<u8>,
    pub(super) end: bool,
}

pub(super) async fn read_stream<R: AsyncRead + Unpin>(
    mut stream: R,
    kind: StreamKind,
    tx: mpsc::Sender<StreamChunk>,
) -> std::io::Result<()> {
    let mut bytes = [0_u8; 8192];
    loop {
        let count = stream.read(&mut bytes).await?;
        if count == 0 {
            let _ = tx
                .send(StreamChunk {
                    kind,
                    bytes: Vec::new(),
                    end: true,
                })
                .await;
            return Ok(());
        }
        let event = StreamChunk {
            kind: match kind {
                StreamKind::Stdout => StreamKind::Stdout,
                StreamKind::Stderr(index) => StreamKind::Stderr(index),
            },
            bytes: bytes[..count].to_vec(),
            end: false,
        };
        if tx.send(event).await.is_err() {
            return Ok(());
        }
    }
}
