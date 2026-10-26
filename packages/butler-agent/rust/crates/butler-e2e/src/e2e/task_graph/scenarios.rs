use super::*;

/// A fan-out and join plan. Longer layouts use a chain after the join.
pub fn actions(count: usize) -> Value {
    let keys = ["a", "b", "c", "d", "e"];
    let titles = ["Prepare", "Build", "Check", "Combine", "Publish"];
    json!((0..count).map(|i| {
        let key = keys.get(i).map_or_else(|| format!("n{i}"), |s| (*s).into());
        let deps = match i { 0 => vec![], 1|2 => vec!["a".to_owned()], 3 => vec!["b".into(), "c".into()],
            _ => vec![keys.get(i-1).map_or_else(|| format!("n{}",i-1), |s| (*s).into())] };
        json!({"actionKey":key,"description":titles.get(i).map_or_else(|| format!("Task {}",i+1), |s| (*s).into()),"dependencyKeys":deps})
    }).collect::<Vec<_>>())
}

impl GraphBuilder {
    /// The real Butler -> Steward topology and accepted workers plan.
    pub async fn graph(
        &mut self,
        parent: &str,
        count: usize,
        title: &str,
    ) -> Result<GraphWork, Error> {
        let (_, mut work) = Box::pin(self.unplanned(parent, 1, title)).await?;
        self.plan(&mut work, "workers", actions(count)).await?;
        self.review(&mut work, "plan", "accept", json!([])).await?;
        Ok(work)
    }

    pub async fn unplanned(
        &mut self,
        parent: &str,
        count: usize,
        title: &str,
    ) -> Result<(GraphWork, GraphWork), Error> {
        let mut owner = self.parent(parent).await?;
        self.plan(&mut owner, "steward", actions(count)).await?;
        self.review(&mut owner, "plan", "accept", json!([])).await?;
        let child = self.steward(&owner, title).await?;
        Ok((owner, child))
    }

    pub async fn plan_child(&mut self, data: &Path, id: &str) -> Result<(), Error> {
        let owner = self.existing(data, id).await?;
        let children = SqliteSubsessionRepository::new(self.storage.clone())
            .relations_for_parent(owner.scope.session_id.clone())
            .await?;
        let child = children
            .into_iter()
            .find(|c| {
                c.packet
                    .parent_work_ref
                    .as_ref()
                    .is_some_and(|r| r.work_id == owner.view.work_id)
            })
            .ok_or("missing delegated child")?;
        let mut work = self.existing(data, &child.root_work_id).await?;
        let count = owner
            .view
            .current_plan
            .ok_or("missing parent plan")?
            .actions
            .len();
        self.plan(&mut work, "workers", actions(count)).await?;
        self.review(&mut work, "plan", "accept", json!([])).await?;
        Ok(())
    }

    pub async fn seed(
        &mut self,
        parent: &str,
        states: &[String],
        count: usize,
    ) -> Result<Vec<String>, Error> {
        let mut graphs = Vec::new();
        for (i, state) in states.iter().enumerate() {
            let title = format!("Release {}", i + 1);
            let mut work = if state == "waiting" {
                self.unplanned(parent, count, &title).await?.0
            } else {
                self.graph(parent, count, &title).await?
            };
            self.seed_state(&mut work, state, count).await?;
            graphs.push(encode_task_graph_id("work:", &work.view.work_id, ""));
        }
        Ok(graphs)
    }

    async fn seed_state(
        &mut self,
        work: &mut GraphWork,
        state: &str,
        count: usize,
    ) -> Result<(), Error> {
        match state {
            "done" | "cancelled" => {
                let updates = json!(work.view.action_progress.iter().map(|a| json!({"actionKey":a.action_key,
                    "status":if state=="cancelled" {"active"}else if a.action_key=="c" {"skipped"}else{"done"}})).collect::<Vec<_>>());
                self.checkpoint(work, updates).await?;
                if state == "cancelled" {
                    self.abandon(work).await?;
                } else {
                    self.review(work, "result", "accept", json!([])).await?;
                    self.review(work, "completion", "accept", json!([])).await?;
                    self.complete(work).await?;
                }
            }
            "running" | "failed" => self.seed_attempts(work, state, count).await?,
            _ => {}
        }
        Ok(())
    }

    async fn seed_attempts(
        &mut self,
        work: &mut GraphWork,
        state: &str,
        count: usize,
    ) -> Result<(), Error> {
        if count > 1 {
            let a = self.worker(work, "a", "Prepare the release").await?;
            self.result(&a, "success", "Preparation checked").await?;
            self.checkpoint(work, json!([{"actionKey":"a","status":"done"}]))
                .await?;
        }
        let keys = if count == 1 {
            vec!["a"]
        } else if count == 2 {
            vec!["b"]
        } else if state == "failed" {
            vec!["c", "b"]
        } else {
            vec!["b", "c"]
        };
        for key in keys {
            let attempt = self.worker(work, key, "Initial implementation").await?;
            self.checkpoint(work, json!([{"actionKey":key,"status":"active"}]))
                .await?;
            if state == "failed" {
                if key == "b" || count == 1 {
                    self.result(&attempt, "failed", "Build check failed")
                        .await?;
                } else {
                    self.result(&attempt, "success", "Check complete").await?;
                    self.checkpoint(work, json!([{"actionKey":key,"status":"done"}]))
                        .await?;
                }
            } else if key == "c" {
                self.result(&attempt, "success", "First check result")
                    .await?;
                self.review(work, "result", "revise", json!([])).await?;
                self.worker(work, key, "Correct the implementation").await?;
            }
        }
        Ok(())
    }

    pub async fn abandon(&mut self, work: &mut GraphWork) -> Result<(), Error> {
        // Starting a new Work in a new Turn abandons the previous open head.
        self.tick();
        let turn = format!("abandon-{}-{}", work.scope.turn_id, self.sequence);
        self.admit(&work.scope.session_id, &turn, SessionRole::Steward)
            .await?;
        self.work
            .start_work(serde_json::from_value(
                json!({"turnId":turn,"sessionId":work.scope.session_id,
            "mutationCallId":turn,"objective":"Follow-up request"}),
            )?)
            .await?;
        Ok(())
    }

    pub async fn complete(&mut self, work: &mut GraphWork) -> Result<(), Error> {
        let id = self.tick();
        work.view = self.work.record_disposition(serde_json::from_value(json!({
            "turnId":work.scope.turn_id,"sessionId":work.scope.session_id,"mutationCallId":format!("complete-{id}"),
            "workId":work.view.work_id,"disposition":"completed","summary":"Release checked",
        }))?).await?;
        Ok(())
    }
}

impl GraphBuilder {
    /// Reload a previously recorded fixture without editing its stored representation.
    pub async fn existing(&self, data: &Path, id: &str) -> Result<GraphWork, Error> {
        let id = decode_task_graph_id(id, "work:").map_or_else(|| id.to_owned(), |(id, _)| id);
        let db = rusqlite::Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
        let turn: String = db.query_row(
            "SELECT origin_turn_id FROM btcc_guided_works WHERE work_id=?1",
            [id],
            |r| r.get(0),
        )?;
        let view = self
            .work
            .bound_work_for_turn(turn.clone())
            .await?
            .ok_or("missing Work")?;
        let scope = WorkTurnScope {
            turn_id: turn,
            session_id: view.session_id.clone(),
            project_ref: None,
        };
        Ok(GraphWork { scope, view })
    }

    pub async fn finish_all(&mut self, data: &Path) -> Result<(), Error> {
        let ids = {
            let db = rusqlite::Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
            let mut query = db.prepare("SELECT w.work_id FROM btcc_guided_works w JOIN btcc_guided_work_plan_revisions p ON p.plan_revision_id=w.current_plan_revision_id WHERE w.status IN ('open','blocked') AND p.execution_mode='workers'")?;
            query
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for id in ids {
            let mut work = self.existing(data, &id).await?;
            self.complete_pending_attempts(data, &work).await?;
            let updates = json!(
                work.view
                    .action_progress
                    .iter()
                    .map(|a| json!({"actionKey":a.action_key,"status":"done"}))
                    .collect::<Vec<_>>()
            );
            self.checkpoint(&mut work, updates).await?;
        }
        Ok(())
    }
}

impl GraphBuilder {
    pub async fn advance_phase(&mut self, work: &mut GraphWork, phase: &str) -> Result<(), Error> {
        if work.view.current_stage == Some(WorkStage::Planning) {
            self.review(work, "plan", "accept", json!([])).await?;
        }
        if phase == "validation" {
            let updates = json!(
                work.view
                    .action_progress
                    .iter()
                    .map(|a| json!({"actionKey":a.action_key,"status":"done"}))
                    .collect::<Vec<_>>()
            );
            self.checkpoint(work, updates).await?;
            self.review(work, "result", "accept", json!([])).await?;
        } else if phase == "reporting" {
            self.review(work, "completion", "accept", json!([])).await?;
        } else {
            return Err("unknown phase".into());
        }
        Ok(())
    }
}

impl GraphBuilder {
    pub async fn complete_pending_attempts(
        &mut self,
        data: &Path,
        work: &GraphWork,
    ) -> Result<(), Error> {
        let attempts = {
            let db = rusqlite::Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
            let mut query=db.prepare("SELECT d.task_id,r.child_session_id,d.child_turn_id FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id WHERE r.parent_session_id=?1 AND NOT EXISTS(SELECT 1 FROM btcc_steward_results x WHERE x.relation_id=r.relation_id AND x.child_turn_id=d.child_turn_id)")?;
            query
                .query_map([&work.scope.session_id], |r| {
                    Ok(Attempt {
                        task: r.get(0)?,
                        session: r.get(1)?,
                        turn: r.get(2)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?
        };
        for attempt in attempts {
            self.result(&attempt, "success", "Checks complete").await?;
        }
        Ok(())
    }
}
