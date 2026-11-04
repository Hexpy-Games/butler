//! Reorder at the real prompt/steering boundary, without a production hold point.
use super::*;
use butler_turn::btcc::{GuidedInvocation, PromptPort, RenderedGuidedPrompt};

pub(super) async fn seed(documents: &BtccRepositories, session: &str) {
    let session = session.to_owned();
    documents.canon_storage().canon_write(move |tx| {
        for (index, id) in ["race_a", "race_b", "race_c"].iter().enumerate() {
            tx.execute("INSERT INTO canon_epics(id,project_id,title,origin,created_at,updated_at,created_by) VALUES(?1,'race_project',?1,'chat',0,0,'{}')", [id])?;
            tx.execute("INSERT INTO canon_session_epics(session_id,epic_id,bound_at,bound_by,origin) VALUES(?1,?2,0,'{}','user')", rusqlite::params![session,id])?;
            tx.execute("INSERT INTO canon_session_queue(session_id,epic_id,chain_id,step_index,stack_position,state,origin) VALUES(?1,?2,'race_chain',?3,0,'waiting','user_message')", rusqlite::params![session,id,index])?;
        }
        Ok(())
    }).await.unwrap();
}

pub(super) struct Factory {
    pub inner: GuidedTurnFactoryAdapter,
    pub reorder: bool,
}
impl GuidedTurnFactory for Factory {
    fn bind_pre_model<'a>(
        &'a self,
        start: GuidedTurnStart<'a>,
    ) -> PortFuture<'a, Box<dyn BoundGuidedTurn + 'a>> {
        Box::pin(async move {
            let mut bound = self.inner.bind_pre_model(start).await?;
            let mut inputs = bound.take_inputs()?;
            if self.reorder {
                inputs.dependencies.prompt = Arc::new(ReorderPrompt {
                    inner: inputs.dependencies.prompt.clone(),
                    documents: self.inner.documents.clone(),
                });
            }
            Ok(Box::new(Bound {
                inner: bound,
                inputs: Some(inputs),
            }) as Box<dyn BoundGuidedTurn + 'a>)
        })
    }
}
struct Bound<'a> {
    inner: Box<dyn BoundGuidedTurn + 'a>,
    inputs: Option<GuidedTurnInputs>,
}
impl BoundGuidedTurn for Bound<'_> {
    fn take_inputs(&mut self) -> Result<GuidedTurnInputs, BtccError> {
        Ok(self.inputs.take().unwrap())
    }
    fn progress(&self) -> &dyn AgentLoopProgress {
        self.inner.progress()
    }
    fn base(&self) -> &dyn ModelRoundPort {
        self.inner.base()
    }
}
struct ReorderPrompt {
    inner: Arc<dyn PromptPort>,
    documents: BtccRepositories,
}
impl PromptPort for ReorderPrompt {
    fn render<'a>(
        &'a self,
        invocation: GuidedInvocation<'a>,
    ) -> PortFuture<'a, RenderedGuidedPrompt> {
        Box::pin(async move {
            let rendered = self.inner.render(invocation).await?;
            assert!(rendered.prompt.contains("canon:epic/race_b: waiting"));
            let session = invocation.turn.session_id.clone();
            self.documents.canon_storage().canon_write(move |tx| {
                butler_canon::store::queue::edit(tx, &butler_canon::store::runtime_context(1), &session,
                    &json!({"op":"set_order","expected_graph_revision":0,"steps":[["race_a"],["race_c"],["race_b"]]}))?;
                Ok(())
            }).await?;
            Ok(rendered)
        })
    }
}
