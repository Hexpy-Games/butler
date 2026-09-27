use std::{future::Future, pin::Pin};

use serde_json::Value;

use crate::btcc::{BtccError, ModelIdentity};

use super::ports::ModelRoundPort;
use super::test_support::Fixture;

struct FixtureExecution<'a> {
    base: &'a dyn ModelRoundPort,
    model: String,
}

impl crate::btcc::model_route::ModelExecutionView for FixtureExecution<'_> {
    fn active_model_ref(&self) -> String {
        self.model.clone()
    }
    fn selected_reasoning_effort(&self) -> crate::btcc::ReasoningEffort {
        crate::btcc::ReasoningEffort::High
    }
    fn accepted_model_identity(&self) -> Option<ModelIdentity> {
        None
    }
}

impl crate::btcc::model_route::ModelExecution for FixtureExecution<'_> {
    fn routed(&self) -> &dyn ModelRoundPort {
        self.base
    }
    fn base(&self) -> &dyn ModelRoundPort {
        self.base
    }
}

impl crate::btcc::model_route::ModelExecutionFactory for Fixture {
    fn create<'a>(
        &self,
        input: crate::btcc::model_route::ModelExecutionInput<'a>,
    ) -> Pin<
        Box<
            dyn Future<
                    Output = Result<
                        Box<dyn crate::btcc::model_route::ModelExecution + 'a>,
                        BtccError,
                    >,
                > + Send
                + 'a,
        >,
    > {
        Box::pin(async move {
            let provider = input
                .turn
                .model_selection
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("provider");
            let model = input
                .turn
                .model_selection
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("model");
            Ok(Box::new(FixtureExecution {
                base: input.base,
                model: format!("{provider}/{model}"),
            })
                as Box<dyn crate::btcc::model_route::ModelExecution>)
        })
    }
}
