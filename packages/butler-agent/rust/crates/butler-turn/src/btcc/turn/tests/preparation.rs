use super::*;

impl TurnPreparation for Harness {
    fn prepare(&self, request: TurnRequest) -> PortFuture<'_, PreparedExecution> {
        let turn_id = request.turn_id.clone();
        Box::pin(async move {
            Ok(PreparedExecution {
                turn: PreparedTurn {
                    preparation_id: turn_id,
                    request,
                    command: json!({"kind": "run"}),
                    admission_input_hash: "hash".into(),
                    is_fresh: true,
                },
                conversation: Box::new(FixtureConversation),
            })
        })
    }
}

struct FixtureConversation;

impl PreparedConversation for FixtureConversation {
    fn record_event<'a>(&'a self, _: &'a RuntimeTurnEventInput) -> PortFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn complete(&self, _: TurnOutcome) -> PortFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn cancel(&self) -> PortFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}
