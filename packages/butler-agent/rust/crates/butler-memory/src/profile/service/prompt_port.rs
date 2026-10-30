//! The profile section of prompts.

use super::super::contracts::ProfileError;
use super::super::{naming, projection};
use super::ProfileService;
impl butler_turn::context_ports::ProfilePromptPort for ProfileService {
    fn naming_profile<'a>(
        &'a self,
        _: &'a butler_turn::context_ports::PromptProjectionInput<'a>,
    ) -> butler_turn::context_ports::ContextFuture<'a, Option<String>> {
        Box::pin(async move {
            self.ensure_default_eol().await.map_err(context_error)?;
            self.read_personalization_profile()
                .await
                .map(|value| naming::render(&value))
                .map_err(context_error)
        })
    }
    fn runtime_profile<'a>(
        &'a self,
        _: &'a butler_turn::context_ports::PromptProjectionInput<'a>,
    ) -> butler_turn::context_ports::ContextFuture<'a, Option<String>> {
        Box::pin(async move {
            match self.read_runtime_profile_projection().await {
                Ok(value) => Ok(value.map(|value| projection::render(&value))),
                Err(_) => Ok(None),
            }
        })
    }
    fn first_chat_onboarding<'a>(
        &'a self,
        _: &'a butler_turn::context_ports::PromptProjectionInput<'a>,
        locale: &'a str,
    ) -> butler_turn::context_ports::ContextFuture<'a, Option<String>> {
        Box::pin(async move {
            self.render_first_chat_onboarding(locale)
                .await
                .map_err(context_error)
        })
    }
}

fn context_error(error: ProfileError) -> butler_turn::context_ports::ContextError {
    butler_turn::context_ports::ContextError::port(error.code(), error.message(), error)
}
