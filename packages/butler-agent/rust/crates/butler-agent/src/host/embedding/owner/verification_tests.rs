//! Healthy verification preserves extraction and only real loads wake memory.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "race assertions")]

use super::*;
use butler_memory::cognition::{
    CandidateSearchInput, CognitionVectorSearch, GenerationVectorAdapter,
};
use butler_platform::process_control::test_support::{clone_peer_input, gated_lines_peer};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStderr, ChildStdin};

mod vector_fixture;

fn owner(
    responses: &[String],
) -> (
    Arc<EmbeddingOwner>,
    ChildStdin,
    BufReader<ChildStderr>,
    Arc<AtomicU64>,
) {
    let mut child = gated_lines_peer(&responses.iter().map(String::as_str).collect::<Vec<_>>())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let gate = clone_peer_input(&stdin).unwrap();
    let reader = BufReader::new(child.stderr.take().unwrap());
    let mut process = Some(WorkerChild {
        stdin,
        stdout: child.stdout.take().unwrap(),
        child,
        initialized: false,
    });
    let inner = readiness_tests::inner();
    let actor_inner = inner.clone();
    let wakes = Arc::new(AtomicU64::new(0));
    let actor_wakes = wakes.clone();
    let owner = readiness_tests::owner(inner, async move {
        run_loop(&actor_inner, &mut process, || {
            actor_wakes.fetch_add(1, Ordering::Relaxed);
        })
        .await;
        assert!(process.is_none());
    });
    (Arc::new(owner), gate, reader, wakes)
}

fn ready_response(id: u64) -> String {
    serde_json::json!({"id": id, "status": "ready"}).to_string()
}

fn deadline() -> i64 {
    chrono::Utc::now().timestamp_millis() + 2_250
}

async fn received(reader: &mut BufReader<ChildStderr>) {
    let mut line = String::new();
    reader.read_line(&mut line).await.unwrap();
    assert_eq!(line.trim(), "received");
}

async fn load(owner: &EmbeddingOwner, gate: &mut ChildStdin, reader: &mut BufReader<ChildStderr>) {
    let ready = owner.ready(deadline());
    tokio::pin!(ready);
    assert!(futures_util::poll!(ready.as_mut()).is_pending());
    received(reader).await;
    gate.write_all(b"\n").await.unwrap();
    ready.await.unwrap();
    assert!(owner.is_warm());
}

pub(super) async fn background_candidates() {
    let started = Instant::now();
    eprintln!("VERIFY-CANDIDATES phase=fixture");
    let fixture = vector_fixture::Fixture::new().await;
    eprintln!(
        "VERIFY-CANDIDATES phase=load elapsed_ms={}",
        started.elapsed().as_millis()
    );
    let responses = [ready_response(1), ready_response(2), fixture.response(3)];
    let (owner, mut gate, mut reader, _) = owner(&responses);
    load(&owner, &mut gate, &mut reader).await;
    owner.start_loading();
    received(&mut reader).await;
    eprintln!(
        "VERIFY-CANDIDATES phase=search elapsed_ms={}",
        started.elapsed().as_millis()
    );
    let adapter =
        GenerationVectorAdapter::new(fixture.root.clone(), Default::default(), owner.clone());
    let search = adapter.search(CandidateSearchInput {
        source_root: &fixture.root,
        generation_id: &fixture.generation.generation_id,
        embedding: fixture.generation.embedding.as_ref(),
        cue: "bike lock code",
        bound_project_id: None,
        deadline_epoch_millis: deadline(),
    });
    tokio::pin!(search);
    let first = futures_util::poll!(search.as_mut());
    gate.write_all(b"\n").await.unwrap();
    let result = match first {
        std::task::Poll::Ready(result) => result,
        // Keep driving the caller while waiting for its worker request. An
        // error/deadline can complete it without the peer receiving a request.
        std::task::Poll::Pending => tokio::select! {
            result = &mut search => result,
            () = received(&mut reader) => {
                eprintln!("VERIFY-CANDIDATES phase=vector-read elapsed_ms={}", started.elapsed().as_millis());
                gate.write_all(b"\n").await.unwrap();
                search.await
            }
        },
    };
    owner.close().await.unwrap();
    // Projection's caller defaults vector failures to no candidates. Exercise
    // the actual adapter, persisted vector, and current-unit receipt filter.
    let hits = result.expect("candidate search must succeed during healthy verification");
    assert_eq!(hits.len(), 1, "verification lost the semantic candidate");
    assert_eq!(hits[0].owner_id, "existing-entity");
    assert_eq!(hits[0].rank, 1);
    assert!(hits[0].distance.abs() < 1e-6);
    eprintln!("VERIFY-CANDIDATES complete=1 owner=existing-entity rank=1");
}

pub(super) async fn readiness() {
    let (owner, mut gate, mut reader, _) = owner(&[ready_response(1), ready_response(2)]);
    load(&owner, &mut gate, &mut reader).await;
    owner.start_loading();
    received(&mut reader).await;
    let warm = owner.is_warm();
    let ready = owner.ready(deadline());
    tokio::pin!(ready);
    let queued = futures_util::poll!(ready.as_mut()).is_pending();
    gate.write_all(b"\n").await.unwrap();
    if queued {
        ready.await.unwrap();
    }
    owner.close().await.unwrap();
    assert!(queued, "recall must queue behind verification");
    assert!(
        warm,
        "warm-only callers must retain admission during verification"
    );
}

pub(super) async fn memory_wakes() {
    let mut deltas = Vec::new();
    for _ in 0..2 {
        // Count only this actor's signals. Inventory revisions also include
        // unrelated process-wide source publications from concurrent tests.
        let (owner, mut gate, mut reader, wakes) =
            owner(&[ready_response(1), ready_response(2), ready_response(4)]);
        load(&owner, &mut gate, &mut reader).await;
        deltas.push(wakes.load(Ordering::Relaxed));
        for _ in 0..2 {
            let before = wakes.load(Ordering::Relaxed);
            owner.start_loading();
            received(&mut reader).await;
            let ready = owner.ready(deadline());
            tokio::pin!(ready);
            assert!(futures_util::poll!(ready.as_mut()).is_pending());
            gate.write_all(b"\n").await.unwrap();
            ready.await.unwrap();
            deltas.push(wakes.load(Ordering::Relaxed) - before);
        }
        owner.close().await.unwrap();
    }
    eprintln!("VERIFY-WAKES load/verify/verify per process: {deltas:?}");
    assert_eq!(deltas, [1, 0, 0, 1, 0, 0]);
}

pub(super) async fn cancelled_inference_keeps_ready_transition() {
    let (owner, mut gate, mut reader, wakes) = owner(&[ready_response(1), ready_response(2)]);
    load(&owner, &mut gate, &mut reader).await;
    let cancellation = CancellationToken::new();
    let work = owner.embed(
        EmbeddingRequest {
            texts: vec!["An explicit instruction".into()],
            mode: EmbeddingMode::CheckedCls,
            resplit: true,
            max_embeddings: Some(1),
            request_class: EmbeddingRequestClass::WarmInteractive,
            deadline_at_epoch_ms: None,
        },
        cancellation.clone(),
    );
    tokio::pin!(work);
    assert!(futures_util::poll!(work.as_mut()).is_pending());
    received(&mut reader).await;
    cancellation.cancel();
    assert_eq!(work.await.err().unwrap().code(), "embed_request_cancelled");
    tokio::time::timeout(Duration::from_secs(2), async {
        while owner.is_warm() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(wakes.load(Ordering::Relaxed), 1);
    assert!(
        owner.take_ready_transition(),
        "consumer missed the completed load"
    );
    assert!(!owner.take_ready_transition(), "load was admitted twice");
    owner.close().await.unwrap();
}
