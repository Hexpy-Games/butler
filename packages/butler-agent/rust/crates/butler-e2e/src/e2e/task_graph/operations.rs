use super::*;

impl GraphBuilder {
    pub async fn parent(&mut self, session: &str) -> Result<GraphWork, Error> {
        let time = self.tick();
        let turn = format!("graph-parent-{time}-{}", self.sequence);
        if self.bindings.get_by_session_id(session).await?.is_none() {
            self.bindings
                .upsert(UpsertSessionBinding {
                    session_id: session.into(),
                    role: BindingRole::Butler,
                    project_id: None,
                    app_project_id: OwnOptional::Absent,
                    ledger_project_id: OwnOptional::Absent,
                    workspace_path: std::env::temp_dir().to_string_lossy().into_owned(),
                    runtime_adapter_id: "btcc-turn-runtime".into(),
                    model_provider_id: "openai".into(),
                    model_ref: "openai/gpt-6-luna".into(),
                    runtime_session_ref: None,
                    provider_thread_ref: None,
                    transport_bindings: vec![SessionTransportBinding {
                        transport: "app".into(),
                        account_id: "app".into(),
                        peer_id: session.into(),
                        thread_id: None,
                    }],
                    lifecycle_state: None,
                    created_at: None,
                    updated_at: None,
                    last_active_at: None,
                    metadata: None,
                })
                .await?;
        }
        self.admit(session, &turn, SessionRole::Butler).await?;
        let scope = WorkTurnScope {
            turn_id: turn,
            session_id: session.into(),
            project_ref: None,
        };
        let view = self.work.start_work(serde_json::from_value(json!({
            "turnId":scope.turn_id,"sessionId":session,"mutationCallId":format!("parent-{time}"),"objective":"Prepare the release",
        }))?).await?;
        Ok(GraphWork { scope, view })
    }

    pub async fn plan(
        &mut self,
        work: &mut GraphWork,
        mode: &str,
        actions: Value,
    ) -> Result<(), Error> {
        let id = self.tick();
        work.view = self.work.replace_plan(serde_json::from_value(json!({
            "turnId":work.scope.turn_id,"sessionId":work.scope.session_id,"mutationCallId":format!("plan-{id}"),
            "objective":"Prepare the release","executionMode":mode,"actions":actions,
            "governingRefs":["SPEC-1@rev-1"],"checks":["All checks pass","api_client.rs is complete"],
        }))?).await?;
        Ok(())
    }

    pub async fn checkpoint(&mut self, work: &mut GraphWork, updates: Value) -> Result<(), Error> {
        let id = self.tick();
        work.view = self.work.record_checkpoint(serde_json::from_value(json!({
            "turnId":work.scope.turn_id,"sessionId":work.scope.session_id,"mutationCallId":format!("checkpoint-{id}"),
            "actionUpdates":updates,"publicSummary":"Progress recorded","nextStep":"Check the release",
        }))?).await?;
        Ok(())
    }

    pub async fn review(
        &mut self,
        work: &mut GraphWork,
        subject: &str,
        verdict: &str,
        updates: Value,
    ) -> Result<(), Error> {
        let id = self.tick();
        work.view = self.work.record_review(serde_json::from_value(json!({
            "turnId":work.scope.turn_id,"sessionId":work.scope.session_id,"mutationCallId":format!("review-{id}"),
            "subject":subject,"verdict":verdict,"summary":"Release checked","corrections":if verdict=="accept" {vec![]}else{vec!["Check again"]},
            "correctionScope":if verdict=="accept" {Value::Null}else{json!("execution")},"actionUpdates":updates,
        }))?).await?;
        Ok(())
    }

    pub async fn steward(
        &mut self,
        parent: &GraphWork,
        objective: &str,
    ) -> Result<GraphWork, Error> {
        self.tick();
        let output = self
            .children
            .delegate_steward(
                StewardDelegationRequest {
                    parent_session_id: parent.scope.session_id.clone(),
                    parent_turn_id: parent.scope.turn_id.clone(),
                    anchor_message_id: "anchor".into(),
                    request: objective.into(),
                    previous_relation_id: None,
                    safe_title: Some(objective.into()),
                    model_ref: "openai/gpt-6-luna".into(),
                    reasoning_effort: "low".into(),
                    access_mode: butler_turn::btcc::AccessMode::ReadOnly,
                    schedule_run: None,
                },
                &parent.view,
            )
            .await?;
        let session = output["child_session_id"]
            .as_str()
            .ok_or("missing steward session")?;
        let child = self.admit_child(session, SessionRole::Steward).await?;
        let scope = WorkTurnScope {
            session_id: child.session,
            turn_id: child.turn,
            project_ref: None,
        };
        let view = self
            .work
            .bound_work_for_turn(scope.turn_id.clone())
            .await?
            .ok_or("missing child Work")?;
        Ok(GraphWork { scope, view })
    }

    pub async fn worker(
        &mut self,
        work: &GraphWork,
        key: &str,
        brief: &str,
    ) -> Result<Attempt, Error> {
        self.tick();
        let output = self
            .children
            .delegate_worker(
                WorkerDelegationRequest {
                    parent_session_id: work.scope.session_id.clone(),
                    parent_turn_id: work.scope.turn_id.clone(),
                    anchor_message_id: "anchor".into(),
                    source_tool_call_id: format!("worker-{}", self.sequence),
                    action_key: key.into(),
                    objective: format!("Complete {key}"),
                    acceptance_criteria: vec!["All checks pass".into()],
                    implementation_brief: brief.into(),
                    safe_title: Some(format!("Task {key}")),
                    profile_id: None,
                    access_mode: butler_turn::btcc::AccessMode::ReadOnly,
                    schedule_run: None,
                },
                &work.view,
            )
            .await?;
        let session = output["child_session_id"]
            .as_str()
            .ok_or_else(|| format!("missing worker: {output}"))?;
        let mut child = self.admit_child(session, SessionRole::Worker).await?;
        child.task = output["task_id"].as_str().ok_or("missing task")?.into();
        Ok(child)
    }

    pub async fn result(
        &mut self,
        attempt: &Attempt,
        status: &str,
        summary: &str,
    ) -> Result<(), Error> {
        self.tick();
        self.children
            .complete_child(&attempt.session, &attempt.turn, status, summary.into())
            .await?;
        Ok(())
    }
}
