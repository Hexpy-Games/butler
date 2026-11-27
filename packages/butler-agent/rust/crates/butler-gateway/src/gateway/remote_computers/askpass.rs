use super::{HttpError, ssh_password::install_failed};
use crate::gateway::crypto;
use std::{
    fmt::Write,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    time::timeout,
};
use tokio_util::task::AbortOnDropHandle;
use zeroize::Zeroizing;

pub(super) struct Askpass {
    pub channel: Zeroizing<String>,
    served: Arc<AtomicUsize>,
    _task: AbortOnDropHandle<()>,
}

impl Askpass {
    #[allow(
        clippy::disallowed_methods,
        reason = "single-use loopback askpass channel that must stay out of HTTP logs"
    )]
    pub(super) async fn start(password: Zeroizing<String>) -> Result<Self, HttpError> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|_| install_failed())?;
        let port = listener.local_addr().map_err(|_| install_failed())?.port();
        let mut token = Zeroizing::new(String::with_capacity(64));
        for byte in crypto::random_bytes() {
            let _ = write!(token, "{byte:02x}");
        }
        let channel = Zeroizing::new(format!("{port}:{}", token.as_str()));
        let served = Arc::new(AtomicUsize::new(0));
        let counted = served.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let _ = timeout(
                    Duration::from_secs(5),
                    serve(stream, &token, &password, &counted),
                )
                .await;
            }
        });
        Ok(Self {
            channel,
            served,
            _task: AbortOnDropHandle::new(task),
        })
    }

    pub(super) fn requests(&self) -> usize {
        self.served.load(Ordering::Relaxed)
    }
}

async fn serve(
    mut stream: TcpStream,
    token: &str,
    password: &str,
    served: &AtomicUsize,
) -> std::io::Result<()> {
    let mut request = Zeroizing::new([0; 65]);
    stream.read_exact(request.as_mut()).await?;
    if request[64] == b'\n'
        && crypto::constant_time_eq(&request[..64], token.as_bytes())
        && served.fetch_add(1, Ordering::Relaxed) == 0
    {
        stream.write_all(password.as_bytes()).await?;
        stream.write_all(b"\n").await?;
    }
    Ok(())
}
