//! The profile section of prompts.

use super::super::contracts::ProfileError;
use super::super::{naming, projection};
use super::ProfileService;
impl butler_runtime::context::ProfilePromptPort for ProfileService {
    fn naming_profile<'a>(
        &'a self,
        _: &'a butler_runtime::context::PromptProjectionInput<'a>,
    ) -> butler_runtime::context::ContextFuture<'a, Option<String>> {
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
        _: &'a butler_runtime::context::PromptProjectionInput<'a>,
    ) -> butler_runtime::context::ContextFuture<'a, Option<String>> {
        Box::pin(async move {
            match self.read_runtime_profile_projection().await {
                Ok(value) => Ok(value.map(|value| projection::render(&value))),
                Err(_) => Ok(None),
            }
        })
    }
    fn first_chat_onboarding<'a>(
        &'a self,
        _: &'a butler_runtime::context::PromptProjectionInput<'a>,
        locale: &'a str,
    ) -> butler_runtime::context::ContextFuture<'a, Option<String>> {
        Box::pin(async move {
            self.render_first_chat_onboarding(locale)
                .await
                .map_err(context_error)
        })
    }
}

fn context_error(error: ProfileError) -> butler_runtime::context::ContextError {
    butler_runtime::context::ContextError::port(error.code(), error.message(), error)
}
