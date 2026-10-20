//! Deterministic owner/child races: pipe gates hold verification, never sleeps.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "race assertions")]

use super::*;
use butler_platform::process_control::test_support::{clone_peer_input, gated_line_peer};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin};

fn held_owner() -> EmbeddingOwner {
    let inner = readiness_tests::inner();
    inner.readiness.publish(true);
    let shutdown = inner.shutdown.clone();
    readiness_tests::owner(inner, shutdown.cancelled_owned())
}

fn peer() -> (Option<WorkerChild>, ChildStdin, BufReader<ChildStderr>) {
    let mut child =
        gated_line_peer(r#"{"id":1,"status":"error","code":"embed_model_unavailable"}"#)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
    let stdin = child.stdin.take().unwrap();
    let gate = clone_peer_input(&stdin).unwrap();
    let received = BufReader::new(child.stderr.take().unwrap());
    let process = WorkerChild {
        stdin,
        stdout: child.stdout.take().unwrap(),
        child,
        initialized: true,
    };
    (Some(process), gate, received)
}

async fn received(reader: &mut BufReader<ChildStderr>) {
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    assert_eq!(line.trim(), "received");
}

fn take_prewarm(owner: &EmbeddingOwner) -> Pending {
    owner.start_loading();
    let item = owner.inner.state.lock().take_next().unwrap();
    assert!(matches!(item.response, PendingResponse::Prewarm));
    item
}

async fn live_verification_failure_attempts_replacement() {
    let owner = held_owner();
    let (mut child, mut gate, mut reader) = peer();
    assert!(child.as_mut().unwrap().child.try_wait().unwrap().is_none());
    let item = take_prewarm(&owner);
    let result = {
        let work = run_item(&owner.inner, &mut child, &item);
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => panic!("verification completed before gate: {:?}", result.map(|_| ())),
            () = received(&mut reader) => {},
        }
        gate.write_all(b"\n").await.unwrap();
        work.await
    };
    // A verification error is embed_model_unavailable. This distinct error
    // proves replacement was attempted using the deliberately absent executable.
    assert_eq!(result.err().unwrap().code(), "embed_worker_unavailable");
    assert!(
        child.is_none(),
        "failed live child reaped before replacement"
    );
    assert!(!owner.is_warm(), "failed verification must revoke warmth");
    owner.close().await.unwrap();
}

async fn readiness_waits_during_verification() {
    let owner = held_owner();
    let (mut child, mut gate, mut reader) = peer();
    let item = take_prewarm(&owner);
    let ready = owner.ready(chrono::Utc::now().timestamp_millis() + 2_250);
    tokio::pin!(ready);
    let was_pending = {
        let work = run_item(&owner.inner, &mut child, &item);
        tokio::pin!(work);
        tokio::select! {
            result = &mut work => panic!("verification completed before gate: {:?}", result.map(|_| ())),
            () = received(&mut reader) => {},
        }
        let pending = futures_util::poll!(ready.as_mut()).is_pending();
        gate.write_all(b"\n").await.unwrap();
        assert_eq!(work.await.err().unwrap().code(), "embed_worker_unavailable");
        pending
    };
    // Resolve the actual queued readiness request through the normal actor.
    if was_pending {
        let next = owner.inner.state.lock().take_next().unwrap();
        let result = run_item(&owner.inner, &mut child, &next).await;
        next.response.send(result);
        assert_eq!(
            ready.await.err().unwrap().code(),
            "embed_worker_unavailable"
        );
    }
    owner.close().await.unwrap();
    assert!(was_pending, "readiness must queue during verification");
}

async fn warm_only_work_cannot_absorb_prewarm() {
    for class in [
        EmbeddingRequestClass::WarmInteractive,
        EmbeddingRequestClass::WarmBackground,
    ] {
        for active in [false, true] {
            let owner = held_owner();
            let (mut child, _gate, _reader) = peer();
            child.as_mut().unwrap().child.kill().await.unwrap();
            let embed = owner.embed(
                EmbeddingRequest {
                    texts: vec!["opportunistic recall".into()],
                    mode: EmbeddingMode::CheckedCls,
                    resplit: false,
                    max_embeddings: None,
                    request_class: class,
                    deadline_at_epoch_ms: None,
                },
                CancellationToken::new(),
            );
            tokio::pin!(embed);
            assert!(futures_util::poll!(embed.as_mut()).is_pending());
            let running = active.then(|| owner.inner.state.lock().take_next().unwrap());
            owner.start_loading();
            let retained = owner
                .inner
                .state
                .lock()
                .interactive
                .iter()
                .any(|item| matches!(item.response, PendingResponse::Prewarm));
            if let Some(item) = running {
                let result = run_item(&owner.inner, &mut child, &item).await;
                assert_eq!(result.as_ref().err().unwrap().code(), "embed_worker_cold");
                item.response.send(result);
                let mut state = owner.inner.state.lock();
                state.active_cancel = None;
                state.release(item.bytes);
            }
            let prewarm = {
                let mut state = owner.inner.state.lock();
                let index = state
                    .interactive
                    .iter()
                    .position(|item| matches!(item.response, PendingResponse::Prewarm));
                index.and_then(|index| state.interactive.remove(index))
            };
            if let Some(item) = prewarm {
                assert_eq!(
                    run_item(&owner.inner, &mut child, &item)
                        .await
                        .err()
                        .unwrap()
                        .code(),
                    "embed_worker_unavailable",
                    "prewarm must attempt a reload"
                );
            }
            kill_and_reap(&mut child).await;
            owner.close().await.unwrap();
            assert!(retained, "prewarm lost: class={class:?} active={active}");
        }
    }
}

async fn off_and_shutdown_prevent_replacement() {
    for off in [true, false] {
        let owner = held_owner();
        let (mut child, _gate, mut reader) = peer();
        let item = take_prewarm(&owner);
        let disable = owner.disable();
        tokio::pin!(disable);
        {
            let work = run_item(&owner.inner, &mut child, &item);
            tokio::pin!(work);
            tokio::select! {
                result = &mut work => panic!("verification completed before gate: {:?}", result.map(|_| ())),
                () = received(&mut reader) => {},
            }
            if off {
                assert!(futures_util::poll!(disable.as_mut()).is_pending());
                assert_eq!(work.await.err().unwrap().code(), "embed_worker_cold");
                // Reproduce publication after disable cleared warmth, from an actor
                // that had observed enabled before the switch to off.
                owner.inner.readiness.publish(true);
            } else {
                owner.inner.close();
                assert_eq!(work.await.err().unwrap().code(), "embed_owner_closed");
            }
        }
        if off {
            let release = run_loop(&owner.inner, &mut child, || {});
            tokio::pin!(release);
            assert!(futures_util::poll!(release.as_mut()).is_pending());
            disable.await;
            owner.enable();
        }
        assert!(
            child.is_none(),
            "interrupted verification reaps without respawn"
        );
        assert!(!owner.is_warm());
        owner.close().await.unwrap();
    }
}

pub(super) async fn regressions() {
    // Report each transition independently so one failing race cannot hide
    // the other verification, admission, or shutdown failures.
    type Case = std::pin::Pin<Box<dyn std::future::Future<Output = ()>>>;
    let cases: Vec<(&str, Case)> = vec![
        (
            "background vector candidates during healthy verification",
            Box::pin(verification_tests::background_candidates()),
        ),
        (
            "warm-only admission with recall readiness queued",
            Box::pin(verification_tests::readiness()),
        ),
        (
            "one memory wake per load, none per verification",
            Box::pin(verification_tests::memory_wakes()),
        ),
        (
            "live verification replacement",
            Box::pin(live_verification_failure_attempts_replacement()),
        ),
        (
            "warm-only dedup",
            Box::pin(warm_only_work_cannot_absorb_prewarm()),
        ),
        (
            "readiness during verification",
            Box::pin(readiness_waits_during_verification()),
        ),
        (
            "off/shutdown guards",
            Box::pin(off_and_shutdown_prevent_replacement()),
        ),
    ];
    let mut failed = Vec::new();
    for (name, case) in cases {
        let started = Instant::now();
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(5), case))
            .catch_unwind()
            .await;
        let passed = matches!(result, Ok(Ok(())));
        eprintln!(
            "PREWARM-RACE {name}: {result:?} elapsed_ms={}",
            started.elapsed().as_millis()
        );
        if !passed {
            failed.push(name);
        }
    }
    assert!(failed.is_empty(), "failed races: {failed:?}");
}
