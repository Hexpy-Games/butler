//! A direction to a project Steward whose Work closed runs on a new Work in the
//! same project. The 과제 keeps its one link, reaches that Work through the
//! relation, and reports done only once no direction is outstanding.
use super::stub::delegated::{DIRECTION, STEER};
use super::*;
use rusqlite::Connection;
use std::sync::atomic::Ordering;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, watch},
};

const BEFORE_WORK: &str = "before-work";
const WORK_STARTED: &str = "work-started";

/// Answers the agent's barrier: each stage waits until the test opens it, or
/// fails it (the agent refuses to continue past that stage).
struct WorkBarrier {
    address: String,
    reached: tokio::sync::Mutex<mpsc::UnboundedReceiver<String>>,
    open: watch::Sender<Vec<(&'static str, u8)>>,
}

impl WorkBarrier {
    async fn start() -> Result<Self, HarnessError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?.to_string();
        let (reached_tx, reached) = mpsc::unbounded_channel();
        let (open, _) = watch::channel(Vec::new());
        let gates = open.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let reached_tx = reached_tx.clone();
                let mut gate = gates.subscribe();
                tokio::spawn(async move {
                    let mut stage = vec![0; 32];
                    let Ok(read) = socket.read(&mut stage).await else {
                        return;
                    };
                    let stage = String::from_utf8_lossy(&stage[..read]).into_owned();
                    let _ = reached_tx.send(stage.clone());
                    let answer = gate
                        .wait_for(|open: &Vec<(&str, u8)>| open.iter().any(|(s, _)| *s == stage))
                        .await
                        .ok()
                        .and_then(|open| open.iter().find(|(s, _)| *s == stage).map(|(_, a)| *a))
                        .unwrap_or(1);
                    let _ = socket.write_u8(answer).await;
                });
            }
        });
        Ok(Self {
            address,
            reached: tokio::sync::Mutex::new(reached),
            open,
        })
    }

    async fn reached(&self, stage: &str) {
        let seen = tokio::time::timeout(Duration::from_secs(60), self.reached.lock().await.recv())
            .await
            .unwrap_or_else(|_| panic!("the direction's turn never reached {stage}"));
        assert_eq!(seen.as_deref(), Some(stage));
    }

    fn open(&self, stage: &'static str) {
        self.open.send_modify(|open| open.push((stage, 1)));
    }

    fn fail(&self, stage: &'static str) {
        self.open.send_modify(|open| open.push((stage, 0)));
    }
}

struct Flow {
    s: Scenario,
    script: Arc<stub::Script>,
    server: tokio::task::JoinHandle<()>,
    id: String,
    barrier: WorkBarrier,
    relation: String,
    session: String,
    chat: String,
    root: String,
    db: Connection,
}

/// Runs a project delegation to its Steward's final report, steers it there,
/// lets the report finish, and stops the direction's turn before its Work.
async fn direction_pending(name: &str, blocked: bool) -> Result<Flow, HarnessError> {
    let barrier = WorkBarrier::start().await?;
    let (s, script, server, id, chat) = setup_env(
        name,
        false,
        false,
        None,
        Some(("BUTLER_E2E_DIRECTION_WORK_BARRIER", barrier.address.clone())),
    )
    .await?;
    script.delegate.store(true, Ordering::SeqCst);
    script.direction_blocked.store(blocked, Ordering::SeqCst);
    let accepted = s.gw.say(&chat, "Delegate the release verification").await?;
    script.wait_held().await;
    s.gw.wait_terminal(
        &chat,
        &s.gw.accepted_turn(&accepted).await?,
        Duration::from_secs(30),
    )
    .await?;
    script.hold_steward.store(true, Ordering::SeqCst);
    script.release();
    tokio::time::timeout(Duration::from_secs(30), script.steward_held.acquire())
        .await
        .expect("Steward result review Turn started")
        .unwrap()
        .forget();
    script.hold_report.store(true, Ordering::SeqCst);
    script.steward_release.add_permits(1);
    script.wait_reporting().await;
    let db = Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (relation, session, root): (String, String, String) = db.query_row(
        "SELECT d.relation_id,r.child_session_id,d.root_work_id FROM btcc_subsession_delegations d JOIN btcc_session_relations r USING(relation_id) WHERE json_extract(d.packet_json,'$.child_role')='steward'",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    script.steer_relation.lock().unwrap().clone_from(&relation);
    s.turn(&chat, STEER).await?;
    let flow = Flow {
        s,
        script,
        server,
        id,
        barrier,
        relation,
        session,
        chat,
        root,
        db,
    };
    assert_eq!(flow.pending()?, 1, "the settled turn keeps the direction");
    flow.script.finish_report();
    flow.barrier.reached(BEFORE_WORK).await;
    flow.delivered(1).await?;
    Ok(flow)
}

impl Flow {
    fn pending(&self) -> Result<i64, HarnessError> {
        Ok(self.db.query_row(
            "SELECT count(*) FROM btcc_subsession_directions WHERE relation_id=?1 AND status='pending'",
            [&self.relation],
            |row| row.get(0),
        )?)
    }

    fn statuses(&self) -> Result<Vec<String>, HarnessError> {
        Ok(self
            .db
            .prepare("SELECT status FROM btcc_steward_results WHERE relation_id=?1 ORDER BY rowid")?
            .query_map([&self.relation], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
    }

    fn works(&self) -> Result<Vec<(String, String, String)>, HarnessError> {
        Ok(self
            .db
            .prepare("SELECT work_id,status,scope_kind FROM btcc_guided_works WHERE session_id=?1 ORDER BY rowid")?
            .query_map([&self.session], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<_, _>>()?)
    }

    fn current_work(&self) -> Result<String, HarnessError> {
        Ok(self.db.query_row(
            "SELECT root_work_id FROM btcc_subsession_delegations WHERE relation_id=?1",
            [&self.relation],
            |row| row.get(0),
        )?)
    }

    fn links(&self) -> Result<i64, HarnessError> {
        Ok(self
            .db
            .query_row("SELECT count(*) FROM canon_epic_work_links", [], |row| {
                row.get(0)
            })?)
    }

    /// Waits until `expected` child results reached the parent.
    async fn delivered(&self, expected: i64) -> Result<(), HarnessError> {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let delivered: i64 = self.db.query_row(
                "SELECT count(*) FROM btcc_subsession_outbox WHERE relation_id=?1 AND status='delivered'",
                [&self.relation],
                |row| row.get(0),
            )?;
            if delivered == expected {
                return Ok(());
            }
            assert!(
                Instant::now() < deadline,
                "delivered={delivered} results={:?}\n{}",
                self.statuses()?,
                self.s.agent.logs()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// The label must stay short of in_review for the whole watch.
    async fn assert_not_in_review(&self, why: &str) -> Result<(), HarnessError> {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let epic = data(
                self.s.gw.get(&format!("/canon/epics/{}", self.id)).await?,
                200,
            );
            assert_ne!(epic["canon_status"], "in_review", "{why}: {epic}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(())
    }

    async fn finish(self) -> Result<(), HarnessError> {
        drop(self.db);
        self.s.finish().await?;
        self.server.abort();
        Ok(())
    }
}

#[tokio::test]
async fn pending_direction_holds_the_epic_short_of_review_until_its_work_is_done()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let flow = direction_pending("CANON-DIRECTION", false).await?;
    flow.assert_not_in_review("a direction is still pending")
        .await?;
    assert_eq!(flow.pending()?, 1, "the window is still open");
    let view = flow
        .s
        .gw
        .get(&format!("/session-view?session_id={}", flow.chat))
        .await?;
    let child = &view.data()["steward_children"][0];
    assert_eq!(child["status"], "active", "{child}");
    assert_eq!(child["terminal"], false, "{child}");
    flow.barrier.open(BEFORE_WORK);
    flow.barrier.reached(WORK_STARTED).await;
    flow.barrier.open(WORK_STARTED);
    flow.delivered(2).await?;
    assert_eq!(flow.statuses()?, ["success", "success"]);
    assert!(
        flow.script.requests.lock().unwrap().iter().any(|request| {
            butler_e2e::e2e::matching::key(
                "/codex/responses",
                request,
                &butler_e2e::e2e::sanitize::Placeholders::default(),
            )
            .user_request
            .starts_with(DIRECTION)
        }),
        "the direction opened no Steward turn"
    );
    assert_eq!(flow.links()?, 1, "one Work per 과제 survives the direction");
    let works = flow.works()?;
    assert_eq!(works.len(), 2, "{works:?}");
    assert_eq!(works[0].0, flow.root, "the first Work keeps its history");
    assert!(
        works
            .iter()
            .all(|(_, status, scope)| status == "completed" && scope == "project"),
        "{works:?}"
    );
    assert_eq!(
        flow.current_work()?,
        works[1].0,
        "the relation follows its current Work"
    );
    wait_label(&flow.s, &flow.id, "in_review").await?;
    let done = progress(&flow.s, &flow.id).await?;
    assert_eq!(done["running"], false, "{done}");
    assert_eq!(done["counts"], json!({"completed":1,"total":1}), "{done}");
    flow.finish().await
}

#[tokio::test]
async fn blocked_direction_keeps_the_epic_short_of_review() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let flow = direction_pending("CANON-DIRECTION-BLOCKED", true).await?;
    flow.barrier.open(BEFORE_WORK);
    flow.barrier.open(WORK_STARTED);
    flow.delivered(2).await?;
    assert_eq!(flow.statuses()?, ["success", "blocked"]);
    flow.assert_not_in_review("the direction's Work is blocked")
        .await?;
    let works = flow.works()?;
    assert_eq!(works.len(), 2, "{works:?}");
    assert_eq!(works[1].1, "blocked", "{works:?}");
    assert_eq!(works[1].2, "project", "{works:?}");
    assert_eq!(flow.current_work()?, works[1].0);
    assert_eq!(flow.links()?, 1);
    flow.finish().await
}

#[tokio::test]
async fn failed_work_start_leaves_the_relation_on_its_real_work() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let flow = direction_pending("CANON-DIRECTION-FAULT", false).await?;
    // The agent refuses to start the direction's Work: the same outcome on
    // every OS, without relying on directory permissions.
    flow.barrier.fail(BEFORE_WORK);
    flow.delivered(2).await?;
    assert_eq!(flow.statuses()?, ["success", "failed"]);
    assert_eq!(flow.pending()?, 0, "the parent has the direction's failure");
    assert_eq!(
        flow.current_work()?,
        flow.root,
        "the relation must not point at a Work that never started"
    );
    assert_eq!(flow.works()?.len(), 1);
    assert_eq!(flow.links()?, 1);
    wait_label(&flow.s, &flow.id, "in_review").await?;
    flow.finish().await
}

#[tokio::test]
async fn crash_after_the_work_starts_leaves_the_relation_on_it() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut flow = direction_pending("CANON-DIRECTION-CRASH", false).await?;
    flow.barrier.open(BEFORE_WORK);
    flow.barrier.reached(WORK_STARTED).await;
    flow.s.crash_and_restart().await?;
    flow.delivered(2).await?;
    assert_eq!(flow.statuses()?, ["success", "failed"]);
    let works = flow.works()?;
    assert_eq!(works.len(), 2, "{works:?}");
    assert_eq!(
        flow.current_work()?,
        works[1].0,
        "the started Work stays reachable"
    );
    assert_eq!(works[1].1, "open", "{works:?}");
    flow.finish().await
}
