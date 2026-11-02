//! Small synthetic history, recorded through the same admission/services.
use super::*;

impl GraphBuilder {
    pub async fn history(&mut self, turns: usize, attempts: usize) -> Result<(), Error> {
        let repositories = &self.turns;
        let body = "x".repeat(26_000);
        for i in 0..turns {
            let id = format!("history-{i:06}");
            let mut prepared = test_prepared_turn();
            prepared.request.turn_id = id.clone();
            prepared.request.session_id = "history".into();
            prepared.request.event_id = id.clone();
            prepared.request.message.id = id.clone();
            prepared.request.message.content = body.clone();
            prepared.preparation_id = id.clone();
            prepared.command = TurnCommand::fixture_run(
                &id,
                "history",
                &id,
                CommandMessage {
                    message_id: id.clone(),
                    content: body.clone(),
                },
                json!({}),
            );
            repositories.load_or_admit(&prepared).await?;
        }
        let work = self
            .graph("butler/history", 1, "Historical request")
            .await?;
        for i in 0..attempts {
            self.worker(&work, "a", &format!("Historical approach {i}"))
                .await?;
        }
        Ok(())
    }
}
