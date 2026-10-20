//! A sent request outlives its waiter but never owner close or hang protection.
use super::*;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

pub(super) async fn abandoned_sent_request_is_bounded_by_close_and_worker_timeout() {
    for close in [true, false] {
        let mut child = butler_platform::process_control::test_support::gated_line_peer("")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("gated protocol peer");
        let pid = child.id().unwrap();
        let mut reader = BufReader::new(child.stderr.take().unwrap());
        let mut process = Some(WorkerChild {
            stdin: child.stdin.take().unwrap(),
            stdout: child.stdout.take().unwrap(),
            child,
            initialized: true,
        });
        let inner = readiness_tests::inner();
        let (sender, receiver) = oneshot::channel();
        let item = Pending {
            id: 1,
            frame: b"{}\n".to_vec(),
            bytes: 3,
            cold_start_allowed: true,
            background: false,
            mode: EmbeddingMode::LegacyMean,
            requested_texts: 1,
            resplit: false,
            max_embeddings: None,
            cancellation: CancellationToken::new(),
            deadline: Some(Instant::now() + Duration::from_secs(1)),
            response: PendingResponse::Embedding(sender),
        };
        let result = {
            let run = run_item(&inner, &mut process, &item);
            tokio::pin!(run);
            let mut line = String::new();
            tokio::select! {
                _ = &mut run => panic!("request completed before send"),
                result = reader.read_line(&mut line) => assert!(result.unwrap() > 0),
            }
            assert_eq!(line.trim(), "received");
            tokio::time::pause();
            drop(receiver);
            item.cancellation.cancel();
            tokio::time::advance(Duration::from_secs(2)).await;
            assert!(futures_util::poll!(run.as_mut()).is_pending());
            assert!(
                butler_platform::instance::process_start(pid)
                    .unwrap()
                    .is_some()
            );
            if close {
                inner.close();
            } else {
                tokio::time::advance(WORKER_RESPONSE_TIMEOUT).await;
            }
            let result = run.await;
            tokio::time::resume();
            result
        };
        assert_eq!(
            result.err().expect("worker must be reaped").code(),
            if close {
                "embed_owner_closed"
            } else {
                "embed_worker_unavailable"
            }
        );
        assert!(process.is_none());
        assert!(
            butler_platform::instance::process_start(pid)
                .unwrap()
                .is_none()
        );
    }
}
