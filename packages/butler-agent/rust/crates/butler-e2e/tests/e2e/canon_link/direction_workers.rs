//! A direction continues a finished Steward under the same relation, so a saved
//! result does not mean it ended: its Workers still report, and still stop.
use super::stub::delegated::STEER;
use super::*;
use crate::canon_plan_run::stop_paths::wait_nothing_runs;
use rusqlite::Connection;
use std::sync::{Arc, atomic::Ordering};

struct Steered {
    s: Scenario,
    script: Arc<stub::Script>,
    server: tokio::task::JoinHandle<()>,
    chat: String,
    relation: String,
    db: Connection,
}

/// Steers a Steward during its final report, then holds the Worker its direction starts.
async fn direction_worker_running(name: &str) -> Result<Steered, HarnessError> {
    let (s, script, server, _, chat) = setup(name, false, false).await?;
    script.delegate.store(true, Ordering::SeqCst);
    script.direction_worker.store(true, Ordering::SeqCst);
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
    let relation: String = db.query_row(
        "SELECT d.relation_id FROM btcc_subsession_delegations d WHERE json_extract(d.packet_json,'$.child_role')='steward'",
        [],
        |row| row.get(0),
    )?;
    script.steer_relation.lock().unwrap().clone_from(&relation);
    s.turn(&chat, STEER).await?;
    script.hold_workers_again();
    script.finish_report();
    script.wait_held().await;
    Ok(Steered {
        s,
        script,
        server,
        chat,
        relation,
        db,
    })
}

impl Steered {
    fn model_calls(&self) -> usize {
        self.script.requests.lock().unwrap().len()
    }

    fn results(&self) -> Result<Vec<String>, HarnessError> {
        Ok(self
            .db
            .prepare("SELECT status FROM btcc_steward_results WHERE relation_id=?1 ORDER BY rowid")?
            .query_map([&self.relation], |row| row.get(0))?
            .collect::<Result<_, _>>()?)
    }

    async fn finish(self) -> Result<(), HarnessError> {
        drop(self.db);
        self.s.finish().await?;
        self.server.abort();
        Ok(())
    }
}

/// The relation already has a result here, yet the direction's Worker must still report.
#[tokio::test]
async fn direction_worker_result_reaches_its_steward() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let flow = direction_worker_running("CANON-DIRECTION-WORKER").await?;
    assert_eq!(flow.results()?, ["success"], "the first Work already ended");
    flow.script.release();
    wait_nothing_runs(&flow.s).await?;
    assert_eq!(
        flow.results()?,
        ["success", "success"],
        "the direction's Work finished from its Worker's result"
    );
    flow.finish().await
}

/// Deleting the chat during the direction's Work stops the Steward and that Worker.
#[tokio::test]
async fn deleting_chat_stops_a_direction_and_its_worker() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let flow = direction_worker_running("CANON-DIRECTION-DELETE").await?;
    let calls = flow.model_calls();
    data(
        flow.s
            .gw
            .delete(&format!("/sessions/{}?permanent=true", flow.chat))
            .await?,
        200,
    );
    wait_nothing_runs(&flow.s).await?;
    flow.script.release();
    wait_nothing_runs(&flow.s).await?;
    assert_eq!(
        flow.model_calls(),
        calls,
        "the subtree kept calling the model"
    );
    flow.finish().await
}
