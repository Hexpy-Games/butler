//! Native worker deadline/grace ownership through stub chat and shutdown.
use super::{ASK, assert_saved_instruction, batch, memory_stubs, recall_tool_ms};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use butler_platform::{instance::process_start, process_control::usage};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub(super) struct Trace {
    file: tokio::fs::File,
    text: String,
}

impl Trace {
    pub(super) async fn open(s: &Scenario, start: u32) -> Result<Self, HarnessError> {
        let mut file =
            tokio::fs::File::open(s.agent.launch.logs.join(format!("agent-{start}.log"))).await?;
        file.seek(std::io::SeekFrom::End(0)).await?;
        Ok(Self {
            file,
            text: String::new(),
        })
    }

    pub(super) async fn drain(&mut self) -> Result<u64, HarnessError> {
        let tail = self.until("draining query grace_ms=").await?;
        Ok(tail.split_whitespace().next().unwrap().parse().unwrap())
    }

    async fn until(&mut self, marker: &str) -> Result<String, HarnessError> {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                self.file.read_to_string(&mut self.text).await?;
                if let Some((_, tail)) = self.text.split_once(marker) {
                    return Ok(tail.to_owned());
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await
        .expect("native worker must reach the expected drain boundary")
    }
}

async fn prepare(name: &str, held: bool) -> Result<(Scenario, String, PathBuf), HarnessError> {
    prepare_with_barrier(name, held, None).await
}

/// With `barrier`, the restarted Agent holds each query drain at its start
/// until the harness answers on that loopback address (stub fixtures only).
async fn prepare_with_barrier(
    name: &str,
    held: bool,
    barrier: Option<&DrainBarrier>,
) -> Result<(Scenario, String, PathBuf), HarnessError> {
    let (setup, remember, code) = batch::setup(name)?;
    let release = setup.sandbox.root.join("embed-release");
    std::fs::write(&release, b"")?;
    let mut s = setup
        .env("BUTLER_MEMORY_SYNC_TRACE", "1")
        .env("BUTLER_E2E_HOLD_POINT", "memory_embedding")
        .env("BUTLER_E2E_HOLD_RELEASE", release.to_string_lossy())
        .start()
        .await?;
    assert_eq!(s.turn("general", &remember).await?.1["state"], "delivered");
    memory_stubs::text_complete(&s.sandbox.data, 1).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 2).await?;
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::vectors_complete(&s.sandbox.data, 3).await?;
    if held {
        s.agent.terminate().await?;
        std::fs::remove_file(&release)?;
        std::fs::remove_file(release.with_extension("held"))?;
        if let Some(barrier) = barrier {
            s.agent
                .launch
                .set_env("BUTLER_E2E_DRAIN_BARRIER", barrier.address.clone());
        }
        s.gw = s.agent.start_again().await?;
    }
    Ok((s, code, release))
}

/// Answers the Agent's drain rendezvous: the drain waits, with its grace not
/// yet running, until the scenario has placed its second request.
struct DrainBarrier {
    address: String,
    listener: tokio::net::TcpListener,
}

impl DrainBarrier {
    async fn start() -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        Ok(Self {
            address: listener.local_addr()?.to_string(),
            listener,
        })
    }

    /// Waits for a drain to start; it stays held until [`Self::release`].
    async fn reached(&self) -> Result<tokio::net::TcpStream, HarnessError> {
        let (mut socket, _) = tokio::time::timeout(Duration::from_secs(30), self.listener.accept())
            .await
            .expect("the query drain never reached its barrier")?;
        let mut stage = [0_u8; 5];
        socket.read_exact(&mut stage).await?;
        assert_eq!(&stage, b"drain");
        Ok(socket)
    }

    /// Lets the held drain start its real grace now.
    async fn release(mut held: tokio::net::TcpStream) -> Result<(), HarnessError> {
        held.write_u8(1).await?;
        Ok(())
    }
}

fn worker(s: &Scenario) -> Result<u32, HarnessError> {
    let workers = usage::embedding_children(s.agent.pid().unwrap())?.unwrap();
    assert_eq!(workers.len(), 1);
    Ok(workers[0])
}

async fn reaped(pid: u32, bound: Duration) -> Result<Duration, HarnessError> {
    let start = Instant::now();
    tokio::time::timeout(bound, async {
        while process_start(pid).unwrap().is_some() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        Ok::<_, HarnessError>(())
    })
    .await
    .expect("worker must be killed and reaped within its bound")?;
    Ok(start.elapsed())
}

#[tokio::test]
async fn expired_query_grace_kills_and_reaps_a_wedged_worker() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, code, _release) = prepare("MEM-DRAIN-EXPIRY", true).await?;
    let mut trace = Trace::open(&s, 2).await?;
    let answer = s.provider()?.hold_after_tool(ASK);
    let observe = async {
        let grace = trace.drain().await?;
        let pid = worker(&s)?;
        let elapsed = reaped(pid, Duration::from_millis(grace + 200)).await?;
        // Require the actual expiry branch, rather than inferring it from a
        // minimum duration that a queued request could race with.
        trace.until("drain_end=deadline").await?;
        eprintln!(
            "DRAIN-EXPIRY grace_ms={grace} reaped_ms={}",
            elapsed.as_millis()
        );
        answer.release();
        Ok::<_, HarnessError>(())
    };
    let (first, ()) = tokio::try_join!(batch::recall(&s, "general", ASK), observe)?;
    assert_saved_instruction(&first, &code, 3);
    assert_eq!(
        first["output"]["coverage"]["vectors"]["state"],
        "unavailable"
    );
    assert!(first["output"]["next_cursor"].is_null());
    s.finish().await
}

#[tokio::test]
async fn owner_close_during_query_drain_reaps_without_waiting_for_grace() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (mut s, _code, _release) = prepare("MEM-DRAIN-CLOSE", true).await?;
    let mut trace = Trace::open(&s, 2).await?;
    let answer = s.provider()?.hold_after_tool(ASK);
    s.gw.say("general", ASK).await?;
    let grace = trace.drain().await?;
    let pid = worker(&s)?;
    let started = Instant::now();
    s.agent.terminate().await?;
    assert!(
        process_start(pid).unwrap().is_none(),
        "close left a draining child"
    );
    butler_e2e::assert_wall_clock_budget!(
        started.elapsed(),
        Duration::from_millis(grace),
        "owner close must interrupt the drain grace"
    );
    eprintln!(
        "DRAIN-CLOSE grace_ms={grace} shutdown_ms={}",
        started.elapsed().as_millis()
    );
    answer.release();
    s.finish().await
}

#[tokio::test]
async fn recall_arriving_during_drain_reuses_the_loaded_worker() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let barrier = DrainBarrier::start().await?;
    let (s, code, release) =
        prepare_with_barrier("MEM-DRAIN-ARRIVAL", true, Some(&barrier)).await?;
    let chat =
        s.gw.post(
            "/sessions",
            serde_json::json!({"kind":"chat","title":"Concurrent recall"}),
        )
        .await?;
    assert_eq!(chat.status, 201, "{}", chat.text);
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let mut trace = Trace::open(&s, 2).await?;
    let first_request = s.provider()?.requests().len();
    let answer = s.provider()?.hold_after_tool(ASK);
    let arriving = async {
        let grace = trace.drain().await?;
        // The drain is held at its start with its grace not yet running, so the
        // second recall's arrival cannot depend on how fast the host is.
        let held_drain = barrier.reached().await?;
        let pid = worker(&s)?;
        wait_output(&s, first_request).await?;
        let mut queued = Trace::open(&s, 2).await?;
        let release_after_arrival = async {
            queued.until("queued class=Interactive texts=1").await?;
            // The real grace starts now, with the second request queued in it.
            DrainBarrier::release(held_drain).await?;
            // Keep inference held while the admitted query waits, exposing any
            // queue-driven reap before allowing the original reply to drain.
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(worker(&s)?, pid, "queued recall reaped the loaded worker");
            std::fs::write(&release, b"")?;
            Ok::<_, HarnessError>(())
        };
        let (second, ()) = tokio::try_join!(batch::recall(&s, &chat, ASK), release_after_arrival)?;
        super::restart::assert_complete(&second, &code, 3);
        assert_eq!(worker(&s)?, pid);
        assert_one_load(&s).await?;
        let tool_ms = recall_tool_ms(&s.sandbox.data);
        butler_e2e::assert_wall_clock_budget!(
            Duration::from_millis(tool_ms.try_into().unwrap()),
            Duration::from_millis(
                (super::recall_budget::TOTAL_MS - super::recall_budget::TEXT_RESERVE_MS)
                    .try_into()
                    .unwrap(),
            ) + super::FALLBACK_ASSEMBLY_ALLOWANCE,
            "recall admitted during drain retains its vector deadline and fallback headroom"
        );
        eprintln!(
            "DRAIN-ARRIVAL grace_ms={grace} second_tool_ms={tool_ms} complete_vector_results=4 same_pid=true spawns=1 loads=1"
        );
        answer.release();
        Ok::<_, HarnessError>(())
    };
    let (first, ()) = tokio::try_join!(batch::recall(&s, "general", ASK), arriving)?;
    assert_saved_instruction(&first, &code, 3);
    s.finish().await
}

/// The other side of the boundary: a recall that arrives only after the drain's
/// deadline finds the worker reaped; it is served without it and the reaped
/// worker never comes back.
#[tokio::test]
async fn recall_arriving_after_the_drain_deadline_finds_the_worker_reaped()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, code, _release) = prepare("MEM-DRAIN-LATE", true).await?;
    let chat =
        s.gw.post(
            "/sessions",
            serde_json::json!({"kind":"chat","title":"Late recall"}),
        )
        .await?;
    assert_eq!(chat.status, 201, "{}", chat.text);
    let chat = chat.data()["session"]["id"].as_str().unwrap().to_owned();
    let mut trace = Trace::open(&s, 2).await?;
    let answer = s.provider()?.hold_after_tool(ASK);
    let expire = async {
        let grace = trace.drain().await?;
        let pid = worker(&s)?;
        trace.until("drain_end=deadline").await?;
        reaped(pid, Duration::from_millis(grace + 200)).await?;
        answer.release();
        Ok::<_, HarnessError>(pid)
    };
    let (first, old) = tokio::try_join!(batch::recall(&s, "general", ASK), expire)?;
    assert_saved_instruction(&first, &code, 3);
    // Only now does the second recall ask: the deadline has passed and the
    // worker is gone, so nothing queued could have reused it.
    let second = batch::recall(&s, &chat, ASK).await?;
    assert_saved_instruction(&second, &code, 4);
    assert!(
        process_start(old).unwrap().is_none(),
        "the reaped worker came back"
    );
    eprintln!(
        "DRAIN-LATE vectors={}",
        second["output"]["coverage"]["vectors"]["state"]
    );
    s.finish().await
}

#[tokio::test]
async fn pending_projection_during_query_drain_keeps_the_just_loaded_worker()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (mut s, code, release) = prepare("MEM-DRAIN-PROJECTION", false).await?;
    // Create genuinely unembedded conversation work. Reopening completed
    // units would recover their persisted receipts without queueing inference.
    let off =
        s.gw.post("/setup/memory-model", serde_json::json!({"enabled":false}))
            .await?;
    assert_eq!(off.status, 200, "{}", off.text);
    batch::recall(&s, "general", ASK).await?;
    memory_stubs::text_complete(&s.sandbox.data, 4).await?;
    let (pending, _) = memory_stubs::unit_states(&s.sandbox.data)?;
    assert!(pending > 0);
    assert!(butler_e2e::e2e::fixtures::embedding_assets(
        &s.sandbox.data
    )?);
    let on =
        s.gw.post("/setup/memory-model", serde_json::json!({"enabled":true}))
            .await?;
    assert_eq!(on.status, 200, "{}", on.text);
    s.agent.terminate().await?;
    std::fs::remove_file(&release)?;
    std::fs::remove_file(release.with_extension("held"))?;
    s.gw = s.agent.start_again().await?;
    assert_eq!(memory_stubs::unit_states(&s.sandbox.data)?.0, pending);
    assert_eq!(
        usage::embedding_children(s.agent.pid().unwrap())?.unwrap(),
        Vec::<u32>::new()
    );
    let mut trace = Trace::open(&s, 2).await?;
    let answer = s.provider()?.hold_after_tool(ASK);
    let release_after_queue = async {
        // Observe actual WarmBackground admission while the cold recall owns
        // the held query frame, rather than inferring queueing from unit state.
        trace.until("queued class=WarmBackground").await?;
        let grace = trace.drain().await?;
        let pid = worker(&s)?;
        assert!(release.with_extension("held").exists());
        std::fs::write(&release, b"")?;
        memory_stubs::vectors_complete(&s.sandbox.data, 4).await?;
        assert_eq!(
            worker(&s)?,
            pid,
            "projection discarded the just-loaded worker"
        );
        assert_eq!(memory_stubs::unit_states(&s.sandbox.data)?.0, 0);
        assert_one_load(&s).await?;
        eprintln!(
            "DRAIN-PROJECTION grace_ms={grace} pending_before={pending} pending_after=0 same_pid=true spawns=1 loads=1"
        );
        answer.release();
        Ok::<_, HarnessError>(pid)
    };
    let (first, pid) = tokio::try_join!(batch::recall(&s, "general", ASK), release_after_queue)?;
    assert_saved_instruction(&first, &code, 4);
    assert_eq!(
        first["output"]["coverage"]["vectors"]["state"],
        "unavailable"
    );
    memory_stubs::vectors_complete(&s.sandbox.data, 5).await?;
    let complete = batch::recall(&s, "general", ASK).await?;
    super::restart::assert_complete(&complete, &code, 5);
    assert_eq!(worker(&s)?, pid);
    assert_one_load(&s).await?;
    s.finish().await
}

async fn assert_one_load(s: &Scenario) -> Result<(), HarnessError> {
    let logs = s.agent.current_logs().await?;
    assert_eq!(logs.matches("[embedding-worker] spawn_ms=").count(), 1);
    assert_eq!(
        logs.matches("[embedding-worker] initialized load_ms=")
            .count(),
        1
    );
    Ok(())
}

#[tokio::test]
async fn background_overrun_still_kills_at_its_projection_deadline() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, code, release) = prepare("MEM-DRAIN-BACKGROUND", false).await?;
    let pid = worker(&s)?;
    let first_request = s.provider()?.requests().len();
    let answer = s.provider()?.hold_after_tool(ASK);
    let arm_background_hold = async {
        // Let the interactive query finish. Hold only the projection of its
        // completed conversation, whose contents still match the recall cue.
        wait_output(&s, first_request).await?;
        std::fs::remove_file(&release)?;
        std::fs::remove_file(release.with_extension("held"))?;
        answer.release();
        Ok::<_, HarnessError>(())
    };
    let (prior, ()) = tokio::try_join!(batch::recall(&s, "general", ASK), arm_background_hold)?;
    assert_saved_instruction(&prior, &code, 3);
    wait_held(&release).await?;
    let started = Instant::now();
    tokio::time::sleep(Duration::from_secs(29)).await;
    assert!(
        process_start(pid).unwrap().is_some(),
        "background worker died before its deadline"
    );
    reaped(pid, Duration::from_secs(2)).await?;
    let elapsed = started.elapsed();
    assert!(!s.agent.current_logs().await?.contains("draining query"));
    std::fs::write(&release, b"")?;
    let demand = batch::recall(&s, "general", ASK).await?;
    assert_saved_instruction(&demand, &code, 4);
    memory_stubs::vectors_complete(&s.sandbox.data, 5).await?;
    let complete = batch::recall(&s, "general", ASK).await?;
    super::restart::assert_complete(&complete, &code, 5);
    eprintln!(
        "DRAIN-BACKGROUND deadline_ms=30000 reaped_ms={} complete_results=6",
        elapsed.as_millis()
    );
    s.finish().await
}

async fn wait_output(s: &Scenario, first_request: usize) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(1), async {
        while !s.provider().unwrap().requests()[first_request..]
            .iter()
            .filter_map(|request| request["input"].as_array())
            .flatten()
            .any(|item| item["type"] == "function_call_output")
        {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("recall must publish its complete tool result");
    Ok(())
}

async fn wait_held(release: &Path) -> Result<(), HarnessError> {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !release.with_extension("held").exists() {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("native inference must reach the hold");
    Ok(())
}
